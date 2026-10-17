//! Local encrypted drafts. The OS store and serialized native owner are the
//! authority; no caller-supplied cache key or network fallback is accepted.
use super::*;
use std::sync::Mutex;
const MAX_JSON: usize = 64 * 1024;
const MAX_REV: u64 = 9_007_199_254_740_991;
static GATE: Mutex<()> = Mutex::new(());
fn hash<T: Serialize>(value: &T) -> Result<String, NetworkError> {
    let bytes = serde_json::to_vec(value).map_err(|_| err("MOBILE_DRAFT_INVALID"))?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
pub(super) fn identity(saved: &SavedAccount, target: &Target) -> Result<String, NetworkError> {
    hash(&(
        &saved.instance.issuer,
        &saved.instance.service_id,
        &saved.instance.environment,
        &saved.instance.network_id,
        &saved.session.principal_id,
        &target.device,
        &target.agent,
    ))
}
#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    record: String,
    identity_key: String,
    device: String,
    agent: String,
    #[serde(deserialize_with = "nullable")]
    session: Option<String>,
    confirmed: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Index {
    version: u8,
    account: String,
    entries: Vec<Entry>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u8,
    identity_key: String,
    agent_id: String,
    #[serde(deserialize_with = "nullable")]
    session_id: Option<String>,
    text: String,
    revision: u64,
    last_write_id: String,
}
fn nullable<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    serde::Deserialize::deserialize(d)
}
fn valid_session(session: &Option<String>) -> bool {
    session.as_ref().is_none_or(|s| {
        !s.is_empty() && s.len() <= 99 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}
fn record_key(identity: &str, session: &Option<String>) -> Result<String, NetworkError> {
    Ok(format!("draft:{}", hash(&(identity, session))?))
}
fn persist<T: Serialize>(
    store: &dyn SecureStore,
    scope: &str,
    key: &str,
    value: &T,
) -> Result<(), NetworkError> {
    let bytes = Zeroizing::new(serde_json::to_vec(value).map_err(|_| err("MOBILE_DRAFT_INVALID"))?);
    if bytes.len() > MAX_JSON {
        return Err(err("MOBILE_DRAFT_CAPACITY"));
    }
    store
        .write_record(scope, key, &bytes)
        .map_err(store_error)?;
    let read = store.read_record(scope, key).map_err(store_error)?;
    if read.as_deref().map(|b| b.as_slice()) != Some(bytes.as_slice()) {
        return Err(err("MOBILE_DRAFT_PERSISTENCE_UNCONFIRMED"));
    }
    Ok(())
}
fn uuid(s: &str) -> bool {
    uuid::Uuid::parse_str(s).is_ok_and(|id| id.to_string() == s)
}
impl MobileConnection {
    pub(super) fn draft(&self, intent: &Value, write: bool) -> Result<Value, NetworkError> {
        let _gate = GATE
            .lock()
            .map_err(|_| err("MOBILE_SECURE_STORE_UNAVAILABLE"))?;
        if serde_json::to_vec(intent)
            .map_err(|_| err("MOBILE_DRAFT_INVALID"))?
            .len()
            > MAX_JSON
        {
            return Err(err("MOBILE_DRAFT_INVALID"));
        }
        if !self.active.load(Ordering::Acquire) {
            return Err(err("OWNED_LOGIN_REQUIRED"));
        }
        let saved = self
            .saved
            .as_ref()
            .ok_or_else(|| err("OWNED_LOGIN_REQUIRED"))?;
        saved.instance.validate(&self.config.issuer)?;
        saved.session.validate(&saved.instance)?;
        if !uuid(&saved.device_id) {
            return Err(err("OWNED_SESSION_INVALID"));
        }
        let target = self
            .targets
            .get(
                intent["targetId"]
                    .as_str()
                    .ok_or_else(|| err("MOBILE_DRAFT_INVALID"))?,
            )
            .ok_or_else(|| err("MOBILE_TARGET_NOT_APPROVED"))?;
        let session = match intent.get("sessionId") {
            Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            _ => return Err(err("MOBILE_DRAFT_INVALID")),
        };
        if !valid_session(&session) {
            return Err(err("MOBILE_DRAFT_INVALID"));
        }
        let identity_key = identity(saved, target)?;
        let account = hash(&(
            &saved.instance.issuer,
            &saved.instance.service_id,
            &saved.instance.environment,
            &saved.instance.network_id,
            &saved.session.principal_id,
        ))?;
        let scope = format!("drafts-v1:{account}");
        let key = record_key(&identity_key, &session)?;
        let mut index = match self
            .store
            .read_record(&scope, "index")
            .map_err(store_error)?
        {
            None => Index {
                version: 1,
                account: account.clone(),
                entries: vec![],
            },
            Some(bytes) if bytes.len() <= MAX_JSON => {
                serde_json::from_slice::<Index>(&bytes).map_err(|_| err("MOBILE_DRAFT_CORRUPT"))?
            }
            _ => return Err(err("MOBILE_DRAFT_CORRUPT")),
        };
        if index.version != 1 || index.account != account || index.entries.len() > 64 {
            return Err(err("MOBILE_DRAFT_CORRUPT"));
        }
        let mut seen = std::collections::HashSet::new();
        for entry in &index.entries {
            let t = Target {
                device: entry.device.clone(),
                agent: entry.agent.clone(),
            };
            if !valid_session(&entry.session)
                || identity(saved, &t)? != entry.identity_key
                || record_key(&entry.identity_key, &entry.session)? != entry.record
                || !seen.insert(&entry.record)
            {
                return Err(err("MOBILE_DRAFT_CORRUPT"));
            }
        }
        let pos = index.entries.iter().position(|e| e.record == key);
        let record = match self.store.read_record(&scope, &key).map_err(store_error)? {
            Some(bytes) if bytes.len() <= MAX_JSON && pos.is_some() => {
                let r: Record =
                    serde_json::from_slice(&bytes).map_err(|_| err("MOBILE_DRAFT_CORRUPT"))?;
                if r.version != 1
                    || r.identity_key != identity_key
                    || r.agent_id != target.agent
                    || !valid_session(&r.session_id)
                    || r.session_id != session
                    || r.revision == 0
                    || r.revision > MAX_REV
                    || !uuid(&r.last_write_id)
                    || r.text.encode_utf16().count() > 16000
                {
                    return Err(err("MOBILE_DRAFT_CORRUPT"));
                }
                Some(r)
            }
            None if pos.is_none_or(|p| !index.entries[p].confirmed) => None,
            _ => return Err(err("MOBILE_DRAFT_CORRUPT")),
        };
        let mut record = record;
        if write {
            let expected = intent["expectedRevision"]
                .as_u64()
                .filter(|r| *r <= MAX_REV)
                .ok_or_else(|| err("MOBILE_DRAFT_INVALID"))?;
            let write_id = intent["writeId"]
                .as_str()
                .filter(|id| uuid(id))
                .ok_or_else(|| err("MOBILE_DRAFT_INVALID"))?;
            let text = intent["text"]
                .as_str()
                .filter(|t| t.encode_utf16().count() <= 16000)
                .ok_or_else(|| err("MOBILE_DRAFT_INVALID"))?;
            let retry = record.as_ref().is_some_and(|r| r.last_write_id == write_id);
            if retry && record.as_ref().unwrap().text != text
                || !retry && record.as_ref().map_or(0, |r| r.revision) != expected
            {
                return Err(err("MOBILE_DRAFT_CONFLICT"));
            }
            let p = match pos {
                Some(p) => p,
                None => {
                    if index.entries.len() == 64 {
                        return Err(err("MOBILE_DRAFT_CAPACITY"));
                    }
                    index.entries.push(Entry {
                        record: key.clone(),
                        identity_key: identity_key.clone(),
                        device: target.device.clone(),
                        agent: target.agent.clone(),
                        session: session.clone(),
                        confirmed: false,
                    });
                    persist(self.store.as_ref(), &scope, "index", &index)?;
                    index.entries.len() - 1
                }
            };
            if !retry {
                let revision = expected
                    .checked_add(1)
                    .filter(|r| *r <= MAX_REV)
                    .ok_or_else(|| err("MOBILE_DRAFT_CONFLICT"))?;
                let next = Record {
                    version: 1,
                    identity_key: identity_key.clone(),
                    agent_id: target.agent.clone(),
                    session_id: session.clone(),
                    text: text.into(),
                    revision,
                    last_write_id: write_id.into(),
                };
                persist(self.store.as_ref(), &scope, &key, &next)?;
                record = Some(next);
            }
            if !index.entries[p].confirmed {
                index.entries[p].confirmed = true;
                persist(self.store.as_ref(), &scope, "index", &index)?;
            }
        }
        Ok(
            json!({"kind":"draft","identityKey":identity_key,"agentId":target.agent,"sessionId":session,
            "text":record.as_ref().map_or("",|r|r.text.as_str()),"revision":record.as_ref().map_or(0,|r|r.revision),
            "lastWriteId":record.as_ref().map(|r|r.last_write_id.as_str())}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffi::tests::{callbacks, Memory};
    fn owner(store: Arc<dyn SecureStore>, saved: Option<SavedAccount>) -> MobileConnection {
        let mut o = MobileConnection::new(
            NativeConfig {
                issuer: "https://draft.example.test".into(),
                public_tls_ca: None,
            },
            store,
        )
        .unwrap();
        o.saved = Some(saved.unwrap_or_else(|| {
            let fixture = crate::agent_network::crypto::tests::Fixture::new();
            let mut jwk = crate::DevicePrivateKey::generate()
                .unwrap()
                .public_jwk()
                .unwrap();
            jwk["kid"] = json!("test");
            jwk["alg"] = json!("ES256");
            jwk["use"] = json!("sig");
            let network = uuid::Uuid::new_v4().to_string();
            SavedAccount {
                device_id: uuid::Uuid::new_v4().to_string(),
                instance: OwnedInstance {
                    version: 1,
                    profile: "owned-device-relay-v1".into(),
                    service_id: uuid::Uuid::new_v4().to_string(),
                    environment: "development".into(),
                    network_id: network.clone(),
                    name: "Test".into(),
                    issuer: o.config.issuer.clone(),
                    login_issuer: "https://login.example.test/dex".into(),
                    protocol: 1,
                    capabilities: vec!["tls13-mtls".into()],
                    root_certificate: fixture.ca.pem(),
                    jwks: json!({"keys":[jwk]}),
                },
                session: OwnedSession {
                    access_token: "a".repeat(43),
                    expires_at: jsonwebtoken::get_current_timestamp() + 600,
                    principal_id: uuid::Uuid::new_v4().to_string(),
                    network_id: network,
                },
            }
        }));
        o.targets.insert(
            "approved".into(),
            Target {
                device: "target-device".into(),
                agent: "agent".into(),
            },
        );
        o
    }
    fn read(session: Value) -> Value {
        json!({"version":1,"kind":"draft.read","targetId":"approved","sessionId":session})
    }
    fn write(session: Value, rev: u64, id: &str, text: &str) -> Value {
        json!({"version":1,"kind":"draft.write","targetId":"approved","sessionId":session,"expectedRevision":rev,"writeId":id,"text":text})
    }
    #[test]
    fn stable_identity_binds_full_tuple_and_ignores_names_and_local_device() {
        let memory = Box::<Memory>::default();
        let o = owner(Arc::new(callbacks(&memory)), None);
        let saved = o.saved.as_ref().unwrap();
        let t = o.targets.get("approved").unwrap();
        let original = identity(saved, t).unwrap();
        assert_eq!(original.len(), 64);
        for part in 0..7 {
            let mut s: SavedAccount =
                serde_json::from_value(serde_json::to_value(saved).unwrap()).unwrap();
            let mut target = t.clone();
            match part {
                0 => s.instance.issuer.push('x'),
                1 => s.instance.service_id.push('x'),
                2 => s.instance.environment.push('x'),
                3 => s.instance.network_id.push('x'),
                4 => s.session.principal_id.push('x'),
                5 => target.device.push('x'),
                _ => target.agent.push('x'),
            }
            assert_ne!(original, identity(&s, &target).unwrap());
        }
        let mut s: SavedAccount =
            serde_json::from_value(serde_json::to_value(saved).unwrap()).unwrap();
        s.instance.name = "renamed Bot".into();
        s.device_id = uuid::Uuid::new_v4().to_string();
        assert_eq!(original, identity(&s, t).unwrap());
        assert_ne!(hash(&("ab", "c")).unwrap(), hash(&("a", "bc")).unwrap());
    }
    #[test]
    fn native_callbacks_survive_restart_and_exact_retry() {
        let memory = Box::<Memory>::default();
        let store: Arc<dyn SecureStore> = Arc::new(callbacks(&memory));
        let mut o = owner(store.clone(), None);
        assert_eq!(o.draft(&read(Value::Null), false).unwrap()["revision"], 0);
        let id = uuid::Uuid::new_v4().to_string();
        let request = write(Value::Null, 0, &id, "private draft");
        let first = o.draft(&request, true).unwrap();
        assert_eq!(first["revision"], 1);
        assert_eq!(first["lastWriteId"], id);
        let saved = o.saved.take();
        drop(o);
        let o = owner(store, saved);
        assert_eq!(o.draft(&read(Value::Null), false).unwrap(), first);
        assert_eq!(o.draft(&request, true).unwrap(), first);
        assert_eq!(
            o.draft(&write(Value::Null, 0, &id, "changed"), true)
                .unwrap_err()
                .code,
            "MOBILE_DRAFT_CONFLICT"
        );
        assert_eq!(
            o.draft(
                &write(Value::Null, 0, &uuid::Uuid::new_v4().to_string(), "stale"),
                true
            )
            .unwrap_err()
            .code,
            "MOBILE_DRAFT_CONFLICT"
        );
        assert_eq!(
            o.draft(
                &write(Value::Null, 1, &uuid::Uuid::new_v4().to_string(), ""),
                true
            )
            .unwrap()["revision"],
            2
        );
    }
    #[test]
    fn account_target_session_isolation_and_current_catalog_fence() {
        let memory = Box::<Memory>::default();
        let mut o = owner(Arc::new(callbacks(&memory)), None);
        o.draft(
            &write(Value::Null, 0, &uuid::Uuid::new_v4().to_string(), "secret"),
            true,
        )
        .unwrap();
        assert_eq!(
            o.draft(&read(json!("another-session")), false).unwrap()["text"],
            ""
        );
        o.targets.get_mut("approved").unwrap().device.push('x');
        assert_eq!(o.draft(&read(Value::Null), false).unwrap()["text"], "");
        o.targets.get_mut("approved").unwrap().device.pop();
        o.saved.as_mut().unwrap().session.principal_id = uuid::Uuid::new_v4().to_string();
        assert_eq!(o.draft(&read(Value::Null), false).unwrap()["text"], "");
        o.targets.clear();
        assert!(o.draft(&read(Value::Null), false).is_err());
        o.targets.insert(
            "approved".into(),
            Target {
                device: "target-device".into(),
                agent: "agent".into(),
            },
        );
        o.active.store(false, Ordering::Release);
        assert!(o.draft(&read(Value::Null), false).is_err());
        o.active.store(true, Ordering::Release);
        o.saved.as_mut().unwrap().session.expires_at = 0;
        assert!(o.draft(&read(Value::Null), false).is_err());
        o.saved = None;
        assert!(o.draft(&read(Value::Null), false).is_err());
    }
    #[test]
    fn draft_session_ids_match_original_session_contract() {
        let memory = Box::<Memory>::default();
        let o = owner(Arc::new(callbacks(&memory)), None);
        let id = uuid::Uuid::new_v4().to_string();
        for invalid in [
            "".to_owned(),
            "a".repeat(100),
            "a/b".into(),
            "a\nb".into(),
            "a\0b".into(),
            "中文".into(),
            "x".repeat(65536),
        ] {
            assert_eq!(
                o.draft(&read(json!(invalid)), false).unwrap_err().code,
                "MOBILE_DRAFT_INVALID"
            );
            assert_eq!(
                o.draft(&write(json!(invalid), 0, &id, ""), true)
                    .unwrap_err()
                    .code,
                "MOBILE_DRAFT_INVALID"
            );
        }
        for valid in ["a".to_owned(), "Az09-".repeat(19) + "abcd"] {
            assert!(o.draft(&write(json!(valid), 0, &id, "kept"), true).is_ok());
        }
        let saved = o.saved.as_ref().unwrap();
        let account = hash(&(
            &saved.instance.issuer,
            &saved.instance.service_id,
            &saved.instance.environment,
            &saved.instance.network_id,
            &saved.session.principal_id,
        ))
        .unwrap();
        let scope = format!("drafts-v1:{account}");
        let bytes = o.store.read_record(&scope, "index").unwrap().unwrap();
        let mut index: Index = serde_json::from_slice(&bytes).unwrap();
        index.entries[0].session = Some("bad/session".into());
        index.entries[0].record =
            record_key(&index.entries[0].identity_key, &index.entries[0].session).unwrap();
        o.store
            .write_record(&scope, "index", &serde_json::to_vec(&index).unwrap())
            .unwrap();
        assert_eq!(
            o.draft(&read(Value::Null), false).unwrap_err().code,
            "MOBILE_DRAFT_CORRUPT"
        );
        o.store.write_record(&scope, "index", &bytes).unwrap();
        let index: Index = serde_json::from_slice(&bytes).unwrap();
        let key = &index.entries[0].record;
        let record = o.store.read_record(&scope, key).unwrap().unwrap();
        let mut record: Record = serde_json::from_slice(&record).unwrap();
        record.session_id = Some("bad/session".into());
        o.store
            .write_record(&scope, key, &serde_json::to_vec(&record).unwrap())
            .unwrap();
        assert_eq!(
            o.draft(&read(json!(index.entries[0].session)), false)
                .unwrap_err()
                .code,
            "MOBILE_DRAFT_CORRUPT"
        );
    }
    #[test]
    fn unconfirmed_os_writes_never_report_success() {
        let memory = Box::<Memory>::default();
        let o = owner(Arc::new(callbacks(&memory)), None);
        memory.discard.store(true, Ordering::SeqCst);
        let id = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            o.draft(&write(Value::Null, 0, &id, "lost"), true)
                .unwrap_err()
                .code,
            "MOBILE_DRAFT_PERSISTENCE_UNCONFIRMED"
        );
        memory.discard.store(false, Ordering::SeqCst);
        o.draft(&write(Value::Null, 0, &id, "kept"), true).unwrap();
        memory.discard.store(true, Ordering::SeqCst);
        assert!(o
            .draft(
                &write(
                    Value::Null,
                    1,
                    &uuid::Uuid::new_v4().to_string(),
                    "lost update"
                ),
                true
            )
            .is_err());
        assert_eq!(o.draft(&read(Value::Null), false).unwrap()["text"], "kept");
    }
    #[test]
    fn draft_quota_utf16_and_safe_revision_boundaries() {
        let memory = Box::<Memory>::default();
        let o = owner(Arc::new(callbacks(&memory)), None);
        let id = uuid::Uuid::new_v4().to_string();
        let text = "🦀".repeat(8000);
        assert!(o.draft(&write(Value::Null, 0, &id, &text), true).is_ok());
        assert!(o
            .draft(
                &write(
                    Value::Null,
                    1,
                    &uuid::Uuid::new_v4().to_string(),
                    &(text + "x")
                ),
                true
            )
            .is_err());
        assert!(o
            .draft(&write(Value::Null, MAX_REV + 1, &id, ""), true)
            .is_err());
        for n in 1..64 {
            o.draft(
                &write(
                    json!(n.to_string()),
                    0,
                    &uuid::Uuid::new_v4().to_string(),
                    "",
                ),
                true,
            )
            .unwrap();
        }
        assert_eq!(
            o.draft(&write(json!("65"), 0, &id, ""), true)
                .unwrap_err()
                .code,
            "MOBILE_DRAFT_CAPACITY"
        );
        assert_eq!(o.draft(&read(json!("65")), false).unwrap()["revision"], 0);
        assert!(o
            .draft(&write(json!("x".repeat(65536)), 0, &id, ""), true)
            .is_err());
    }
    #[test]
    fn missing_or_foreign_persisted_record_is_never_silently_overwritten() {
        let memory = Box::<Memory>::default();
        let o = owner(Arc::new(callbacks(&memory)), None);
        let id = uuid::Uuid::new_v4().to_string();
        o.draft(&write(Value::Null, 0, &id, "keep"), true).unwrap();
        let s = o.saved.as_ref().unwrap();
        let account = hash(&(
            &s.instance.issuer,
            &s.instance.service_id,
            &s.instance.environment,
            &s.instance.network_id,
            &s.session.principal_id,
        ))
        .unwrap();
        let scope = format!("drafts-v1:{account}");
        let key = record_key(
            &identity(s, o.targets.get("approved").unwrap()).unwrap(),
            &None,
        )
        .unwrap();
        let original = o.store.read_record(&scope, &key).unwrap().unwrap();
        o.store.remove_record(&scope, &key).unwrap();
        assert_eq!(
            o.draft(
                &write(
                    Value::Null,
                    0,
                    &uuid::Uuid::new_v4().to_string(),
                    "overwrite"
                ),
                true
            )
            .unwrap_err()
            .code,
            "MOBILE_DRAFT_CORRUPT"
        );
        let mut corrupt: Value = serde_json::from_slice(&original).unwrap();
        corrupt["agentId"] = json!("foreign");
        o.store
            .write_record(&scope, &key, &serde_json::to_vec(&corrupt).unwrap())
            .unwrap();
        assert_eq!(
            o.draft(&read(Value::Null), false).unwrap_err().code,
            "MOBILE_DRAFT_CORRUPT"
        );
        o.store.write_record(&scope, &key, &original).unwrap();
        o.store.remove_record(&scope, "index").unwrap();
        assert_eq!(
            o.draft(&write(Value::Null, 0, &id, "keep"), true)
                .unwrap_err()
                .code,
            "MOBILE_DRAFT_CORRUPT"
        );
    }
    #[tokio::test]
    async fn draft_intents_are_closed_and_do_not_need_network_client() {
        let memory = Box::<Memory>::default();
        let mut o = owner(Arc::new(callbacks(&memory)), None);
        assert!(o.client.is_none());
        assert_eq!(
            o.request(read(Value::Null)).await["value"]["lastWriteId"],
            Value::Null
        );
        let mut v = read(Value::Null);
        v["identityKey"] = json!("injected");
        assert_eq!(o.request(v).await["error"]["code"], "MOBILE_INTENT_INVALID");
        let mut v = read(Value::Null);
        v.as_object_mut().unwrap().remove("sessionId");
        assert!(!o.request(v).await["ok"].as_bool().unwrap());
        assert!(o.client.is_none());
        let original = o
            .request(write(
                Value::Null,
                0,
                &uuid::Uuid::new_v4().to_string(),
                "survives suspend",
            ))
            .await;
        let target = o.targets["approved"].clone();
        o.request(json!({"version":1,"kind":"connection.suspend"}))
            .await;
        assert_eq!(
            o.request(read(Value::Null)).await["error"]["code"],
            "MOBILE_TARGET_NOT_APPROVED"
        );
        o.targets.insert("new-approved-id".into(), target);
        let mut restored = read(Value::Null);
        restored["targetId"] = json!("new-approved-id");
        assert_eq!(o.request(restored).await["value"], original["value"]);
    }
}
