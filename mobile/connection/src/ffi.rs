use crate::{
    CryptoError, DevicePrivateKey, IdentityStore, KeyScope, MobileConnection, NativeConfig,
    SecureStore,
};
use std::{ffi::c_void, sync::Arc};
use zeroize::Zeroizing;
const MAX: usize = 256 * 1024;
#[repr(C)]
pub struct MoxConnectionBuffer {
    pub data: *mut u8,
    pub len: usize,
    pub status: i32,
}
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MoxConnectionStore {
    pub context: *mut c_void,
    pub read: unsafe extern "C" fn(
        *mut c_void,
        *const u8,
        usize,
        *const u8,
        usize,
        *mut u8,
        usize,
    ) -> i64,
    pub write: unsafe extern "C" fn(
        *mut c_void,
        *const u8,
        usize,
        *const u8,
        usize,
        *const u8,
        usize,
    ) -> i32,
    pub remove: unsafe extern "C" fn(*mut c_void, *const u8, usize, *const u8, usize) -> i32,
}
// Native contract requires thread safe callbacks and context lifetime through free.
unsafe impl Send for MoxConnectionStore {}
unsafe impl Sync for MoxConnectionStore {}
impl SecureStore for MoxConnectionStore {
    fn read_record(&self, s: &str, r: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        let mut b = Zeroizing::new(vec![0; MAX]);
        let n = unsafe {
            (self.read)(
                self.context,
                s.as_ptr(),
                s.len(),
                r.as_ptr(),
                r.len(),
                b.as_mut_ptr(),
                MAX,
            )
        };
        match n {
            -1 => Ok(None),
            0..=262144 => {
                b.truncate(n as usize);
                Ok(Some(b))
            }
            _ => Err("MOBILE_SECURE_STORE_UNAVAILABLE".into()),
        }
    }
    fn write_record(&self, s: &str, r: &str, b: &[u8]) -> Result<(), String> {
        if b.len() > MAX {
            return Err("MOBILE_SECURE_STORE_CAPACITY".into());
        }
        if unsafe {
            (self.write)(
                self.context,
                s.as_ptr(),
                s.len(),
                r.as_ptr(),
                r.len(),
                b.as_ptr(),
                b.len(),
            )
        } == 0
        {
            Ok(())
        } else {
            Err("MOBILE_SECURE_STORE_UNAVAILABLE".into())
        }
    }
    fn remove_record(&self, s: &str, r: &str) -> Result<(), String> {
        if unsafe { (self.remove)(self.context, s.as_ptr(), s.len(), r.as_ptr(), r.len()) } == 0 {
            Ok(())
        } else {
            Err("MOBILE_SECURE_STORE_UNAVAILABLE".into())
        }
    }
}
fn scope(s: &KeyScope) -> Result<String, CryptoError> {
    serde_json::to_string(s).map_err(|_| CryptoError::CredentialUnavailable)
}
impl IdentityStore for MoxConnectionStore {
    fn load(&self, s: &KeyScope) -> Result<DevicePrivateKey, CryptoError> {
        let b = self
            .read_record(&scope(s)?, "identity-pkcs8")
            .map_err(|_| CryptoError::CredentialUnavailable)?
            .ok_or(CryptoError::CredentialMissing)?;
        DevicePrivateKey::from_native_pkcs8(b)
    }
    fn save_pending(&self, s: &KeyScope, k: &DevicePrivateKey) -> Result<(), CryptoError> {
        // The native owner serializes calls; shared original identity gates also
        // serialize equal KeyScope enrollment across handles in this process.
        match self.load(s) {
            Ok(existing) => {
                return if existing.public_fingerprint()? == k.public_fingerprint()? {
                    Ok(())
                } else {
                    Err(CryptoError::CredentialConflict)
                }
            }
            Err(CryptoError::CredentialMissing) => {}
            Err(e) => return Err(e),
        }
        k.with_native_pkcs8(|b| {
            self.write_record(&scope(s)?, "identity-pkcs8", b)
                .map_err(|_| CryptoError::CredentialUnavailable)
        })?;
        let persisted = self
            .load(s)
            .map_err(|_| CryptoError::CredentialPersistenceUnconfirmed)?;
        if persisted.public_fingerprint()? != k.public_fingerprint()? {
            return Err(CryptoError::CredentialPersistenceUnconfirmed);
        }
        Ok(())
    }
    fn delete(&self, s: &KeyScope) -> Result<(), CryptoError> {
        self.remove_record(&scope(s)?, "identity-pkcs8")
            .map_err(|_| CryptoError::CredentialUnavailable)
    }
}
// Validate raw JSON with original typed DTOs before Value normalization so
// duplicate security fields and unknown request fields remain rejected.
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase", deny_unknown_fields)]
enum ClosedIntent {
    #[serde(rename = "account.status")]
    AccountStatus { version: u8 },
    #[serde(rename = "account.login.start")]
    LoginStart { version: u8 },
    #[serde(rename = "account.login.poll")]
    LoginPoll { version: u8 },
    #[serde(rename = "account.logout")]
    Logout { version: u8 },
    #[serde(rename = "targets.list")]
    Targets { version: u8 },
    #[serde(rename = "operations.pending")]
    Operations { version: u8 },
    #[serde(rename = "connection.suspend")]
    Suspend { version: u8 },
    #[serde(rename = "draft.read")]
    DraftRead {
        version: u8,
        target_id: String,
        #[serde(deserialize_with = "nullable_session")]
        session_id: Option<String>,
    },
    #[serde(rename = "draft.write")]
    DraftWrite {
        version: u8,
        target_id: String,
        #[serde(deserialize_with = "nullable_session")]
        session_id: Option<String>,
        expected_revision: u64,
        write_id: String,
        text: String,
    },
    #[serde(rename = "mobile")]
    Mobile {
        version: u8,
        target_id: String,
        request: myagents_host_management_protocol::RemoteMobileRequest,
    },
    #[serde(rename = "assets")]
    Assets {
        version: u8,
        target_id: String,
        request: myagents_host_management_protocol::RemoteAssetRequest,
    },
    #[serde(rename = "session")]
    Session {
        version: u8,
        target_id: String,
        request: myagents_host_management_protocol::RemoteSessionRequest,
    },
}
fn nullable_session<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    serde::Deserialize::deserialize(d)
}
fn parse_intent(bytes: &[u8]) -> Result<serde_json::Value, ()> {
    let typed: ClosedIntent = serde_json::from_slice(bytes).map_err(|_| ())?;
    if matches!(
        typed,
        ClosedIntent::DraftRead { .. } | ClosedIntent::DraftWrite { .. }
    ) && bytes.len() > 64 * 1024
    {
        return Err(());
    }
    if let ClosedIntent::Mobile { request, .. } = &typed {
        if bytes.len() > 64 * 1024 || request.validate().is_err() {
            return Err(());
        }
    }
    serde_json::from_slice(bytes).map_err(|_| ())
}
pub struct MoxConnection {
    runtime: tokio::runtime::Runtime,
    connection: MobileConnection,
}
fn buffer(value: serde_json::Value) -> MoxConnectionBuffer {
    let b = serde_json::to_vec(&value)
        .unwrap_or_default()
        .into_boxed_slice();
    let len = b.len();
    MoxConnectionBuffer {
        data: Box::into_raw(b) as *mut u8,
        len,
        status: if value["ok"] == true { 0 } else { 1 },
    }
}
fn failure(code: &str) -> MoxConnectionBuffer {
    buffer(serde_json::json!({"ok":false,"error":{"kind":"error","code":code}}))
}
unsafe fn input<'a>(p: *const u8, n: usize) -> Result<&'a [u8], ()> {
    if p.is_null() || n == 0 || n > MAX {
        Err(())
    } else {
        Ok(std::slice::from_raw_parts(p, n))
    }
}
/// # Safety
/// Input and error pointers must reference valid buffers for the supplied lengths.
/// Store callbacks must be thread safe and their context must outlive the handle.
#[no_mangle]
pub unsafe extern "C" fn mox_connection_new(
    p: *const u8,
    n: usize,
    store: MoxConnectionStore,
    error: *mut MoxConnectionBuffer,
) -> *mut MoxConnection {
    let result = std::panic::catch_unwind(|| {
        let bytes = input(p, n).map_err(|_| "MOBILE_CONFIG_INVALID".to_owned())?;
        let config: NativeConfig =
            serde_json::from_slice(bytes).map_err(|_| "MOBILE_CONFIG_INVALID".to_owned())?;
        let connection = MobileConnection::new(config, Arc::new(store))?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|_| "MOBILE_RUNTIME_UNAVAILABLE".to_owned())?;
        Ok::<_, String>(Box::into_raw(Box::new(MoxConnection {
            runtime,
            connection,
        })))
    });
    match result {
        Ok(Ok(handle)) => handle,
        other => {
            if !error.is_null() {
                *error = failure(&match other {
                    Ok(Err(code)) => code,
                    _ => "MOBILE_INTERNAL_ERROR".into(),
                });
            }
            std::ptr::null_mut()
        }
    }
}
/// # Safety
/// The handle must be live, calls serialized, and input readable for n bytes.
#[no_mangle]
pub unsafe extern "C" fn mox_connection_request(
    h: *mut MoxConnection,
    p: *const u8,
    n: usize,
) -> MoxConnectionBuffer {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let h = h.as_mut().ok_or(())?;
        let v = parse_intent(input(p, n)?)?;
        Ok::<_, ()>(buffer(h.runtime.block_on(h.connection.request(v))))
    })) {
        Ok(Ok(b)) => b,
        Ok(Err(_)) => failure("MOBILE_INTENT_INVALID"),
        Err(_) => failure("MOBILE_INTERNAL_ERROR"),
    }
}
/// # Safety
/// The buffer must be returned by this library and freed exactly once.
#[no_mangle]
pub unsafe extern "C" fn mox_connection_buffer_free(b: MoxConnectionBuffer) {
    if !b.data.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            b.data, b.len,
        )));
    }
}
/// # Safety
/// The handle must come from new and be freed once with no concurrent calls.
#[no_mangle]
pub unsafe extern "C" fn mox_connection_free(h: *mut MoxConnection) {
    if !h.is_null() {
        drop(Box::from_raw(h));
    }
}

#[cfg(target_os = "android")]
/// # Safety
/// JNIEnv and jobject must belong to the current JNI invocation and be valid.
#[no_mangle]
pub unsafe extern "C" fn mox_connection_android_init(
    env: *mut c_void,
    context: *mut c_void,
) -> i32 {
    let Ok(mut env) = jni::JNIEnv::from_raw(env.cast()) else {
        return -1;
    };
    let context = jni::objects::JObject::from_raw(context.cast());
    match rustls_platform_verifier::android::init_with_env(&mut env, context) {
        Ok(()) => 0,
        Err(_) => -1,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Mutex,
        },
    };
    type Records = HashMap<(Vec<u8>, Vec<u8>), Vec<u8>>;
    #[derive(Default)]
    pub(crate) struct Memory {
        records: Mutex<Records>,
        writes: AtomicUsize,
        pub(crate) discard: AtomicBool,
    }
    unsafe extern "C" fn read(
        c: *mut c_void,
        s: *const u8,
        sn: usize,
        r: *const u8,
        rn: usize,
        b: *mut u8,
        n: usize,
    ) -> i64 {
        let c = &*(c as *const Memory);
        let records = c.records.lock().unwrap();
        let key = (
            std::slice::from_raw_parts(s, sn).to_vec(),
            std::slice::from_raw_parts(r, rn).to_vec(),
        );
        let Some(value) = records.get(&key) else {
            return -1;
        };
        if value.len() > n {
            return -2;
        }
        std::ptr::copy_nonoverlapping(value.as_ptr(), b, value.len());
        value.len() as i64
    }
    unsafe extern "C" fn write(
        c: *mut c_void,
        s: *const u8,
        sn: usize,
        r: *const u8,
        rn: usize,
        b: *const u8,
        n: usize,
    ) -> i32 {
        let c = &*(c as *const Memory);
        c.writes.fetch_add(1, Ordering::SeqCst);
        if !c.discard.load(Ordering::SeqCst) {
            c.records.lock().unwrap().insert(
                (
                    std::slice::from_raw_parts(s, sn).to_vec(),
                    std::slice::from_raw_parts(r, rn).to_vec(),
                ),
                std::slice::from_raw_parts(b, n).to_vec(),
            );
        }
        0
    }
    unsafe extern "C" fn remove(
        c: *mut c_void,
        s: *const u8,
        sn: usize,
        r: *const u8,
        rn: usize,
    ) -> i32 {
        let c = &*(c as *const Memory);
        c.records.lock().unwrap().remove(&(
            std::slice::from_raw_parts(s, sn).to_vec(),
            std::slice::from_raw_parts(r, rn).to_vec(),
        ));
        0
    }
    pub(crate) fn callbacks(c: &Memory) -> MoxConnectionStore {
        MoxConnectionStore {
            context: c as *const _ as *mut c_void,
            read,
            write,
            remove,
        }
    }
    #[test]
    fn raw_mobile_is_closed_before_value_normalization_and_bounded_separately() {
        let valid = serde_json::json!({"version":1,"kind":"mobile","targetId":"approved","request":{"kind":"mobile.start","version":1,"agentId":"agent","operationId":uuid::Uuid::new_v4().to_string(),"text":"hello","assetIds":[]}});
        let bytes = serde_json::to_vec(&valid).unwrap();
        assert!(parse_intent(&bytes).is_ok());
        let raw = String::from_utf8(bytes).unwrap();
        for duplicate in [
            raw.replace("\"targetId\":", "\"targetId\":\"another\",\"targetId\":"),
            raw.replace("\"agentId\":", "\"agentId\":\"foreign\",\"agentId\":"),
            raw.replace("\"text\":", "\"text\":\"duplicate\",\"text\":"),
        ] {
            assert!(parse_intent(duplicate.as_bytes()).is_err());
        }
        let mut unknown = valid.clone();
        unknown["request"]["path"] = serde_json::json!("injected");
        assert!(parse_intent(&serde_json::to_vec(&unknown).unwrap()).is_err());
        let mut too_large = valid.clone();
        too_large["request"]["text"] = serde_json::json!("\0".repeat(9000));
        assert!(serde_json::to_vec(&too_large).unwrap().len() < 64 * 1024);
        assert!(parse_intent(&serde_json::to_vec(&too_large).unwrap()).is_err());
        let mut padded = serde_json::to_vec(&valid).unwrap();
        padded.extend(vec![b' '; 65536]);
        assert!(parse_intent(&padded).is_err());
        let mut wrong_method = valid;
        wrong_method["kind"] = serde_json::json!("session");
        assert!(parse_intent(&serde_json::to_vec(&wrong_method).unwrap()).is_err());
    }
    #[test]
    fn raw_drafts_reject_duplicate_unknown_missing_and_oversize_fields() {
        let id = uuid::Uuid::new_v4().to_string();
        let valid = serde_json::json!({"version":1,"kind":"draft.write","targetId":"approved","sessionId":null,"expectedRevision":0,"writeId":id,"text":""});
        assert!(parse_intent(&serde_json::to_vec(&valid).unwrap()).is_ok());
        for suffix in [
            r#","text":"duplicate"}"#,
            r#","identityKey":"injected"}"#,
            r#","expectedRevision":1}"#,
        ] {
            let original = valid.to_string();
            let raw = format!("{}{}", &original[..original.len() - 1], suffix);
            assert!(parse_intent(raw.as_bytes()).is_err());
        }
        let read = br#"{"version":1,"kind":"draft.read","targetId":"a","sessionId":null}"#;
        assert!(parse_intent(read).is_ok());
        let mut padded = read.to_vec();
        padded.extend(vec![b' '; 65536]);
        assert!(parse_intent(&padded).is_err());
        for revision in [serde_json::json!(-1), serde_json::json!(0.5)] {
            let mut invalid = valid.clone();
            invalid["expectedRevision"] = revision;
            assert!(parse_intent(&serde_json::to_vec(&invalid).unwrap()).is_err());
        }
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove("sessionId");
        assert!(parse_intent(&serde_json::to_vec(&missing).unwrap()).is_err());
        let mut oversized = valid;
        oversized["text"] = serde_json::json!("x".repeat(65536));
        assert!(parse_intent(&serde_json::to_vec(&oversized).unwrap()).is_err());
        assert!(parse_intent(
            br#"{"version":1,"kind":"draft.read","targetId":"a","sessionId":null,"sessionId":"b"}"#
        )
        .is_err());
    }
    fn key_scope() -> KeyScope {
        KeyScope {
            issuer: "https://test.example".into(),
            environment: "development".into(),
            service_id: "service".into(),
            principal_id: "account".into(),
            device_id: "device".into(),
            key_generation: 1,
        }
    }
    #[test]
    fn raw_intents_preserve_original_duplicate_and_unknown_field_rejection() {
        for bytes in [br#"{"version":1,"version":1,"kind":"account.status"}"#.as_slice(),br#"{"version":1,"kind":"session","targetId":"target","request":{"kind":"list","agentId":"safe","agentId":"other","limit":30}}"#.as_slice(),br#"{"version":1,"kind":"session","targetId":"target","request":{"kind":"list","agentId":"safe","limit":30,"accessToken":"private"}}"#.as_slice(),br#"{"version":1,"kind":"account.status","issuer":"https://untrusted.invalid"}"#.as_slice()] {assert!(parse_intent(bytes).is_err());}
        assert!(parse_intent(br#"{"version":1,"kind":"session","targetId":"approved","request":{"kind":"list","agentId":"safe","limit":30}}"#).is_ok());
    }
    #[test]
    fn raw_asset_profile_is_closed_and_preserves_session_v1() {
        assert!(parse_intent(br#"{"version":1,"kind":"assets","targetId":"approved","request":{"kind":"capabilities","version":1,"agentId":"agent"}}"#).is_ok());
        for raw in [br#"{"version":1,"kind":"assets","targetId":"approved","request":{"kind":"capabilities","version":1,"agentId":"agent","agentId":"other"}}"#.as_slice(),br#"{"version":1,"kind":"assets","targetId":"approved","request":{"kind":"capabilities","version":1,"agentId":"agent","path":"/private/file"}}"#.as_slice(),br#"{"version":1,"kind":"session","targetId":"approved","request":{"kind":"start","agentId":"agent","operationId":"00000000-0000-0000-0000-000000000001","text":"hi","assets":[]}}"#.as_slice()] {assert!(parse_intent(raw).is_err());}
    }
    #[test]
    fn native_key_save_is_idempotent_conflict_safe_and_readback_verified() {
        let memory = Memory::default();
        let store = callbacks(&memory);
        let scope = key_scope();
        let key = DevicePrivateKey::generate().unwrap();
        store.save_pending(&scope, &key).unwrap();
        store.save_pending(&scope, &key).unwrap();
        assert_eq!(memory.writes.load(Ordering::SeqCst), 1);
        let replacement = DevicePrivateKey::generate().unwrap();
        assert!(matches!(
            store.save_pending(&scope, &replacement),
            Err(CryptoError::CredentialConflict)
        ));
        assert_eq!(
            store.load(&scope).unwrap().public_fingerprint().unwrap(),
            key.public_fingerprint().unwrap()
        );
        let memory = Memory::default();
        memory.discard.store(true, Ordering::SeqCst);
        assert!(matches!(
            callbacks(&memory).save_pending(&scope, &key),
            Err(CryptoError::CredentialPersistenceUnconfirmed)
        ));
    }
    #[test]
    fn corrupt_existing_key_never_overwrites_and_account_scopes_are_isolated() {
        let memory = Memory::default();
        let store = callbacks(&memory);
        let first = key_scope();
        store
            .write_record(&scope(&first).unwrap(), "identity-pkcs8", b"corrupt")
            .unwrap();
        let key = DevicePrivateKey::generate().unwrap();
        assert!(store.save_pending(&first, &key).is_err());
        assert_eq!(memory.writes.load(Ordering::SeqCst), 1);
        let mut second = first.clone();
        second.principal_id = "second-account".into();
        store.save_pending(&second, &key).unwrap();
        assert!(store.load(&second).is_ok());
        assert!(store.load(&first).is_err());
    }
}
