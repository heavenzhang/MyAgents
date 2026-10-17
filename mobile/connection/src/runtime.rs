#[path = "drafts.rs"]
mod drafts;
#[path = "peer.rs"]
mod peer;
use crate::agent_network::{
    account::{NetworkAccountSession, OwnedAccount},
    connection::{initial_hello, send},
    identity::NetworkIdentity,
    memory::MemoryBudget,
    owned_login::{OwnedClient, OwnedInstance, OwnedPoll, OwnedSession},
    transport::{NetworkRoute, NetworkSocket, NetworkTransport},
    NetworkError,
};
use crate::IdentityStore;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{SinkExt, StreamExt};
use moxbots_mobile_core::{JournalRecord, JournalRequest};
use myagents_agent_network_protocol::{
    CatalogSnapshot, ClientMessage, ConnectionScope, DeviceScope, ServerEnvelope, ServerMessage,
};
use myagents_host_management_protocol::CanonicalUuid;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio_tungstenite::tungstenite::Message;
use zeroize::Zeroizing;

/// Only the native application may construct this configuration. Trust is an
/// installed product configuration, never JavaScript input or discovered UI text.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeConfig {
    pub issuer: String,
    pub public_tls_ca: Option<String>,
}
/// Synchronous OS persistence. save MUST durably finish before returning. Values
/// contain account bearer secrets and must never be logged or returned to JS.
pub trait SecureStore: IdentityStore {
    fn read_record(&self, scope: &str, record: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String>;
    fn write_record(&self, scope: &str, record: &str, value: &[u8]) -> Result<(), String>;
    fn remove_record(&self, scope: &str, record: &str) -> Result<(), String>;
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedAccount {
    device_id: String,
    instance: OwnedInstance,
    session: OwnedSession,
}
struct PendingLogin {
    device: String,
    verifier: Zeroizing<String>,
    transaction: String,
    expires: u64,
}
struct Connected {
    identity: NetworkIdentity,
    transport: NetworkTransport,
    socket: NetworkSocket,
    scope: ConnectionScope,
    local: DeviceScope,
}
#[derive(Clone, PartialEq, Eq)]
struct Target {
    device: String,
    agent: String,
}
pub struct MobileConnection {
    config: NativeConfig,
    store: Arc<dyn SecureStore>,
    client: Option<OwnedClient>,
    instance: Option<OwnedInstance>,
    saved: Option<SavedAccount>,
    pending: Option<PendingLogin>,
    active: Arc<AtomicBool>,
    connected: Option<Connected>,
    peer: Option<peer::PeerConnection>,
    targets: HashMap<String, Target>,
}
fn err(code: &'static str) -> NetworkError {
    NetworkError::new(code)
}
fn store_error(_: String) -> NetworkError {
    err("MOBILE_SECURE_STORE_UNAVAILABLE")
}
impl MobileConnection {
    pub fn new(config: NativeConfig, store: Arc<dyn SecureStore>) -> Result<Self, String> {
        if crate::agent_network::account::origin(&config.issuer).map_err(|e| e.code)?
            != config.issuer
        {
            return Err("NETWORK_URL_INVALID".into());
        }
        Ok(Self {
            config,
            store,
            client: None,
            instance: None,
            saved: None,
            pending: None,
            active: Arc::new(AtomicBool::new(true)),
            connected: None,
            peer: None,
            targets: HashMap::new(),
        })
    }
    /// JS receives only closed projections. Secrets stay in this native owner.
    pub async fn request(&mut self, intent: Value) -> Value {
        match tokio::time::timeout(Duration::from_secs(90), self.request_inner(intent)).await {
            Ok(Ok(v)) => json!({"ok":true,"value":v}),
            Ok(Err(e)) => json!({"ok":false,"error":{"kind":"error","code":e.code}}),
            Err(_) => {
                self.connected = None;
                self.peer = None;
                json!({"ok":false,"error":{"kind":"error","code":"MOBILE_OPERATION_TIMEOUT"}})
            }
        }
    }
    async fn discover(&mut self) -> Result<(), NetworkError> {
        if self.client.is_none() {
            let (client, instance) =
                OwnedClient::discover(&self.config.issuer, self.config.public_tls_ca.as_deref())
                    .await?;
            self.client = Some(client);
            self.instance = Some(instance);
        }
        Ok(())
    }
    fn account_view(&self) -> Value {
        let saved = self
            .saved
            .as_ref()
            .filter(|s| s.session.expires_at > jsonwebtoken::get_current_timestamp());
        json!({"kind":"account","state":if self.pending.is_some(){"authenticating"}else if saved.is_some(){"signed-in"}else if self.saved.is_some(){"expired"}else{"signed-out"},"displayName":Value::Null,"principalId":saved.map(|s|s.session.principal_id.as_str())})
    }
    async fn restore(&mut self) -> Result<(), NetworkError> {
        if self.saved.is_some() {
            return Ok(());
        }
        let Some(bytes) = self
            .store
            .read_record(&self.config.issuer, "account")
            .map_err(store_error)?
        else {
            return Ok(());
        };
        self.discover().await?;
        let saved: SavedAccount =
            serde_json::from_slice(&bytes).map_err(|_| err("OWNED_SESSION_INVALID"))?;
        self.instance
            .as_ref()
            .unwrap()
            .ensure_same_trust(&saved.instance)?;
        if saved.session.expires_at > jsonwebtoken::get_current_timestamp() {
            self.client
                .as_ref()
                .unwrap()
                .validate_session(&saved.device_id, &saved.session)
                .await?;
        }
        self.saved = Some(saved);
        Ok(())
    }
    async fn cancel(&mut self) -> Result<(), NetworkError> {
        self.connected = None;
        self.peer = None;
        self.targets.clear();
        if let Some(p) = self.pending.take() {
            return self
                .client
                .as_ref()
                .unwrap()
                .cancel(&p.device, &p.transaction, &p.verifier)
                .await;
        }
        Ok(())
    }
    async fn request_inner(&mut self, intent: Value) -> Result<Value, NetworkError> {
        if intent["version"] != 1 || intent.as_object().is_none() {
            return Err(err("MOBILE_INTENT_INVALID"));
        }
        let kind = intent["kind"]
            .as_str()
            .ok_or_else(|| err("MOBILE_INTENT_INVALID"))?;
        let allowed = if kind == "draft.read" {
            &["version", "kind", "targetId", "sessionId"][..]
        } else if kind == "draft.write" {
            &[
                "version",
                "kind",
                "targetId",
                "sessionId",
                "expectedRevision",
                "writeId",
                "text",
            ][..]
        } else if kind == "session" || kind == "assets" || kind == "mobile" {
            &["version", "kind", "targetId", "request"][..]
        } else {
            &["version", "kind"][..]
        };
        if intent
            .as_object()
            .unwrap()
            .keys()
            .any(|key| !allowed.contains(&key.as_str()))
        {
            return Err(err("MOBILE_INTENT_INVALID"));
        }
        match kind {
            "draft.read" => self.draft(&intent, false),
            "draft.write" => self.draft(&intent, true),
            "account.status" => {
                self.restore().await?;
                Ok(self.account_view())
            }
            "account.login.start" => {
                self.restore().await?;
                if self
                    .saved
                    .as_ref()
                    .is_some_and(|s| s.session.expires_at <= jsonwebtoken::get_current_timestamp())
                {
                    self.saved = None;
                    self.store
                        .remove_record(&self.config.issuer, "account")
                        .map_err(store_error)?;
                }
                self.discover().await?;
                self.cancel().await?;
                if self.saved.is_some() {
                    return Err(err("MOBILE_LOGOUT_REQUIRED"));
                }
                // Same PKCE construction as original owned_account_desktop::pkce:
                // four UUIDv4 values provide 488 random bits in a 128-byte verifier.
                let verifier = Zeroizing::new(
                    (0..4)
                        .map(|_| uuid::Uuid::new_v4().simple().to_string())
                        .collect::<String>(),
                );
                let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
                let device = uuid::Uuid::new_v4().to_string();
                let start = self
                    .client
                    .as_ref()
                    .unwrap()
                    .start(&device, &challenge)
                    .await?;
                self.pending = Some(PendingLogin {
                    device,
                    verifier,
                    transaction: start.transaction_id,
                    expires: start.expires_at,
                });
                Ok(
                    json!({"kind":"login","authorizationUrl":start.authorization_url,"expiresAt":start.expires_at}),
                )
            }
            "account.login.poll" => {
                let p = self
                    .pending
                    .as_ref()
                    .ok_or_else(|| err("OWNED_LOGIN_REQUIRED"))?;
                if p.expires <= jsonwebtoken::get_current_timestamp() {
                    self.pending = None;
                    return Err(err("OWNED_LOGIN_EXPIRED"));
                }
                let result = self
                    .client
                    .as_ref()
                    .unwrap()
                    .poll(&p.device, &p.transaction, &p.verifier)
                    .await?;
                if let OwnedPoll::Authenticated(session) = result {
                    let saved = SavedAccount {
                        device_id: p.device.clone(),
                        instance: self.instance.as_ref().unwrap().clone(),
                        session,
                    };
                    let bytes = Zeroizing::new(
                        serde_json::to_vec(&saved).map_err(|_| err("OWNED_SESSION_INVALID"))?,
                    );
                    self.store
                        .write_record(&self.config.issuer, "account", &bytes)
                        .map_err(store_error)?;
                    self.saved = Some(saved);
                    self.pending = None;
                    self.active = Arc::new(AtomicBool::new(true));
                }
                Ok(self.account_view())
            }
            "account.logout" => {
                let disk = self
                    .store
                    .read_record(&self.config.issuer, "account")
                    .map_err(store_error)?;
                self.active.store(false, Ordering::Release);
                self.connected = None;
                self.peer = None;
                self.targets.clear();
                let saved = match self.saved.take() {
                    Some(saved) => Ok(Some(saved)),
                    None => disk
                        .as_ref()
                        .map(|bytes| {
                            serde_json::from_slice::<SavedAccount>(bytes)
                                .map_err(|_| err("OWNED_SESSION_INVALID"))
                        })
                        .transpose(),
                };
                // Clear local credentials even when remote revocation or stored
                // account validation fails; report the remote error honestly.
                self.store
                    .remove_record(&self.config.issuer, "account")
                    .map_err(store_error)?;
                let canceled = self.cancel().await;
                let logout = if let Some(saved) = saved? {
                    saved.instance.validate(&self.config.issuer)?;
                    OwnedClient::pinned(
                        saved.instance.clone(),
                        self.config.public_tls_ca.as_deref(),
                    )?
                    .logout(&saved.session.access_token)
                    .await
                } else {
                    Ok(())
                };
                canceled?;
                logout?;
                Ok(self.account_view())
            }
            "connection.suspend" => {
                self.connected = None;
                self.peer = None;
                self.targets.clear();
                Ok(json!({"kind":"connection","state":"suspended"}))
            }
            "session" => self.session(&intent).await,
            "mobile" => self.mobile(&intent).await,
            "assets" => self.assets(&intent).await,
            "operations.pending" => {
                self.restore().await?;
                self.operations_pending()
            }
            "targets.list" => {
                self.connect().await?;
                let result = self.list_targets().await;
                if result.is_err() {
                    self.targets.clear();
                    self.peer = None;
                }
                if self.peer.as_ref().is_some_and(|p| {
                    !self.targets.values().any(|target| {
                        target.device == p.target.device && target.agent == p.target.agent
                    })
                }) {
                    self.peer = None;
                }
                // Metadata-only connections are closed after the snapshot;
                // a retained combined peer stays alive for interleaved RPCs.
                if let Some(mut c) = self.connected.take() {
                    let _ = c.socket.close(None).await;
                }
                result
            }
            _ => Err(err("MOBILE_INTENT_UNSUPPORTED")),
        }
    }
    async fn connect(&mut self) -> Result<(), NetworkError> {
        // A healthy same-target peer survives routine directory refresh. Pump
        // bounded idle controls first, so real policy revocation invalidates it.
        if let Some(mut p) = self.peer.take() {
            if p.reusable(&p.target, &self.active) {
                match p.drain_idle().await {
                    Ok(()) => {
                        self.peer = Some(p);
                        return Ok(());
                    }
                    Err(error) if error.code == "NETWORK_CONNECTION_CLOSED" => {}
                    Err(error) => {
                        self.targets.clear();
                        return Err(error);
                    }
                }
            }
        }
        if let Some(c) = &self.connected {
            c.identity.account.ensure_current()?;
            return Ok(());
        }
        self.connected = Some(self.new_connection().await?);
        Ok(())
    }
    async fn new_connection(&mut self) -> Result<Connected, NetworkError> {
        self.restore().await?;
        let saved = self
            .saved
            .as_ref()
            .ok_or_else(|| err("OWNED_LOGIN_REQUIRED"))?;
        self.client
            .as_ref()
            .unwrap()
            .validate_session(&saved.device_id, &saved.session)
            .await?;
        let active = self.active.clone();
        let guard = active.clone();
        let account = NetworkAccountSession::Owned(Arc::new(OwnedAccount {
            binding_id: uuid::Uuid::new_v4().to_string(),
            connection_id: uuid::Uuid::new_v4().to_string(),
            device_id: saved.device_id.clone(),
            session_bound: true,
            descriptor: saved.instance.clone(),
            active,
            session: saved.session.clone(),
            public_tls_ca: self.config.public_tls_ca.clone(),
            join_authorized: AtomicBool::new(false),
            guard: Arc::new(move || {
                if guard.load(Ordering::Acquire) {
                    Ok(())
                } else {
                    Err(err("ACCOUNT_BINDING_CHANGED"))
                }
            }),
        }));
        let identity =
            NetworkIdentity::initialize_with_store(account, None, self.store.clone()).await?;
        let transport = NetworkTransport::new_with_public_ca(
            &identity.network_url,
            identity.device_key(),
            MemoryBudget::default(),
            identity.account.public_tls_ca(),
        )?;
        // Login is explicit mobile enrollment consent. The grant is consumed once;
        // reconnect never automatically replays a membership mutation.
        let grant = self
            .store
            .read_record(&self.config.issuer, &format!("joined:{}", saved.device_id))
            .map_err(store_error)?
            .is_none();
        if grant {
            self.store
                .write_record(
                    &self.config.issuer,
                    &format!("joined:{}", saved.device_id),
                    b"attempted",
                )
                .map_err(store_error)?;
        }
        crate::agent_network::owned_admission::enroll(&identity, &transport, grant).await?;
        let mut socket = transport.websocket(&identity.token).await?;
        send(
            &mut socket,
            ClientMessage::Hello {
                client_version: env!("CARGO_PKG_VERSION").into(),
                capabilities: vec!["tls13-mtls".into()],
                previous_connection: None,
            },
        )
        .await?;
        let (scope, local, _) = initial_hello(&mut socket, &identity).await?;
        let catalog = serde_json::to_value(CatalogSnapshot {
            version: 1,
            connection_epoch: scope.connection_epoch.clone(),
            catalog_seq: 1,
            items: vec![],
        })
        .map_err(|_| err("CATALOG_INVALID"))?;
        let uploaded = transport
            .json(NetworkRoute::Catalog, &identity.token, Some(catalog))
            .await?;
        if uploaded["connectionEpoch"] != scope.connection_epoch || uploaded["catalogSeq"] != 1 {
            return Err(err("CATALOG_NOT_CURRENT"));
        }
        let policy =
            crate::agent_network::policy::hydrate_owned(&transport, &identity.token, &local)
                .await?;
        if !policy.joined {
            return Err(err("OWNED_MEMBERSHIP_REQUIRED"));
        }
        send(
            &mut socket,
            ClientMessage::Ready {
                scope: scope.clone(),
                catalog_seq: 1,
            },
        )
        .await?;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match socket.next().await {
                    Some(Ok(Message::Ping(p))) => socket
                        .send(Message::Pong(p))
                        .await
                        .map_err(|_| err("NETWORK_CONNECTION_CLOSED"))?,
                    Some(Ok(Message::Text(t))) => {
                        let envelope = ServerEnvelope::parse(t.as_bytes())
                            .map_err(|_| err("CONTROL_INVALID"))?;
                        if envelope.message.scope() != Some(&scope) {
                            return Err(err("CONTROL_SCOPE_MISMATCH"));
                        }
                        match envelope.message {
                            ServerMessage::Ready { catalog_seq: 1, .. } => return Ok(()),
                            ServerMessage::Error { code, .. } => {
                                return Err(NetworkError::cloud(&code, 400))
                            }
                            _ => return Err(err("READY_PRECONDITION_FAILED")),
                        }
                    }
                    _ => return Err(err("NETWORK_CONNECTION_CLOSED")),
                }
            }
        })
        .await
        .map_err(|_| err("NETWORK_HELLO_TIMEOUT"))??;
        Ok(Connected {
            identity,
            transport,
            socket,
            scope,
            local,
        })
    }
    async fn list_targets(&mut self) -> Result<Value, NetworkError> {
        let c = self
            .connected
            .as_ref()
            .or_else(|| self.peer.as_ref().map(|p| &p.c))
            .ok_or_else(|| err("NETWORK_NOT_CONNECTED"))?;
        c.identity.account.ensure_current()?;
        let devices = c
            .transport
            .json(
                NetworkRoute::Devices {
                    cursor: None,
                    limit: 100,
                },
                &c.identity.token,
                None,
            )
            .await?;
        let previous_targets = std::mem::take(&mut self.targets);
        let mut items = Vec::new();
        let mut has_more = devices["complete"] != true;
        for device in devices["items"]
            .as_array()
            .ok_or_else(|| err("NETWORK_RESPONSE_INVALID"))?
        {
            if device["principalId"] != c.local.principal_id
                || device["networkId"] != c.local.network_id
                || device["deviceId"] == c.local.device_id
                || device["joined"] != true
            {
                continue;
            }
            let device_id = device["deviceId"]
                .as_str()
                .ok_or_else(|| err("NETWORK_RESPONSE_INVALID"))?;
            let agents = c
                .transport
                .json(
                    NetworkRoute::Agents {
                        device_id,
                        cursor: None,
                        limit: 100,
                    },
                    &c.identity.token,
                    None,
                )
                .await?;
            has_more |= agents["complete"] != true;
            for agent in agents["items"]
                .as_array()
                .ok_or_else(|| err("NETWORK_RESPONSE_INVALID"))?
            {
                if agent["principalId"] != c.local.principal_id
                    || agent["networkId"] != c.local.network_id
                    || agent["deviceId"] != device_id
                {
                    return Err(err("NETWORK_METADATA_SCOPE_MISMATCH"));
                }
                if agent["enabled"] != true {
                    continue;
                }
                let id = agent["localAgentId"]
                    .as_str()
                    .ok_or_else(|| err("NETWORK_RESPONSE_INVALID"))?;
                if items.len() >= 100 {
                    has_more = true;
                    break;
                }
                let opaque = catalog_target_id(&previous_targets, device_id, id);
                self.targets.insert(
                    opaque.clone(),
                    Target {
                        device: device_id.into(),
                        agent: id.into(),
                    },
                );
                let identity_key = drafts::identity(
                    self.saved
                        .as_ref()
                        .ok_or_else(|| err("OWNED_LOGIN_REQUIRED"))?,
                    &Target {
                        device: device_id.into(),
                        agent: id.into(),
                    },
                )?;
                items.push(json!({"identityKey":identity_key,"targetId":opaque,"agentId":id,"name":agent["name"].as_str().unwrap_or("").chars().take(256).collect::<String>(),"deviceName":device["name"].as_str().unwrap_or("").chars().take(256).collect::<String>(),"online":device["connectionState"]=="ready","runtime":Value::Null}));
            }
            if items.len() >= 100 {
                has_more = true;
                break;
            }
        }
        c.identity.account.ensure_current()?;
        Ok(json!({"kind":"targets","items":items,"hasMore":has_more}))
    }
}

fn catalog_target_id(previous: &HashMap<String, Target>, device: &str, agent: &str) -> String {
    previous
        .iter()
        .find(|(_, target)| target.device == device && target.agent == agent)
        .map(|(id, _)| id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}
fn approval_matches(
    snapshot: &Value,
    request: &myagents_host_management_protocol::RemoteSessionRequest,
) -> bool {
    let myagents_host_management_protocol::RemoteSessionRequest::Respond {
        generation,
        turn_id,
        request_id,
        interaction,
        approved,
        ..
    } = request
    else {
        return false;
    };
    let Ok(expected) = serde_json::to_value(interaction) else {
        return false;
    };
    snapshot["kind"] == "snapshot"
        && snapshot["generation"] == *generation
        && snapshot["turnId"] == *turn_id
        && snapshot["interactions"].as_array().is_some_and(|items| {
            items.iter().any(|i| {
                i["requestId"] == *request_id
                    && i["generation"] == *generation
                    && i["turnId"] == *turn_id
                    && i["interaction"] == expected
                    && (!approved || i["actionable"] == true)
            })
        })
}
fn journal_scope(scope: &crate::KeyScope) -> Result<String, NetworkError> {
    serde_json::to_string(&(
        scope.issuer.as_str(),
        scope.service_id.as_str(),
        scope.environment.as_str(),
        scope.principal_id.as_str(),
    ))
    .map_err(|_| err("IDENTITY_SCOPE_MISMATCH"))
}
// Metadata only; the SDK remains the digest/crypto/recovery authority. The
// untagged SDK union preserves legacy record JSON exactly.
trait JournalMetadata {
    fn agent_id(&self) -> &str;
    fn session_id(&self) -> Option<&str>;
    fn operation_id(&self) -> Option<CanonicalUuid>;
    fn mutation(&self) -> bool;
    fn protocol(&self) -> &'static str;
    fn validate(&self) -> Result<(), myagents_host_management_protocol::CodecError>;
}
impl JournalMetadata for JournalRequest {
    fn agent_id(&self) -> &str {
        match self {
            Self::Legacy(r) => r.agent_id(),
            Self::Mobile(r) => r.agent_id(),
        }
    }
    fn session_id(&self) -> Option<&str> {
        match self {
            Self::Legacy(r) => r.session_id(),
            Self::Mobile(r) => r.session_id(),
        }
    }
    fn operation_id(&self) -> Option<CanonicalUuid> {
        match self {
            Self::Legacy(r) => r.operation_id(),
            Self::Mobile(r) => r.operation_id(),
        }
    }
    fn mutation(&self) -> bool {
        match self {
            Self::Legacy(r) => r.mutation(),
            Self::Mobile(r) => r.mutation(),
        }
    }
    fn protocol(&self) -> &'static str {
        match self {
            Self::Legacy(_) => "session",
            Self::Mobile(_) => "mobile",
        }
    }
    fn validate(&self) -> Result<(), myagents_host_management_protocol::CodecError> {
        match self {
            Self::Legacy(r) => r.validate(),
            Self::Mobile(r) => r.validate(),
        }
    }
}
fn journal_request(record: &Value) -> Result<JournalRequest, NetworkError> {
    let _: JournalRecord =
        serde_json::from_value(record.clone()).map_err(|_| err("MOBILE_JOURNAL_INVALID"))?;
    let request: JournalRequest = serde_json::from_value(record["request"].clone())
        .map_err(|_| err("MOBILE_JOURNAL_INVALID"))?;
    request
        .validate()
        .map_err(|_| err("MOBILE_JOURNAL_INVALID"))?;
    if !request.mutation()
        || request.operation_id().map(|id| json!(id)) != Some(record["operationId"].clone())
    {
        return Err(err("MOBILE_JOURNAL_INVALID"));
    }
    Ok(request)
}
impl MobileConnection {
    fn pending_operations(&self, scope: &str) -> Result<Vec<String>, NetworkError> {
        let Some(bytes) = self
            .store
            .read_record(scope, "pending-operations")
            .map_err(store_error)?
        else {
            return Ok(Vec::new());
        };
        let ids: Vec<String> =
            serde_json::from_slice(&bytes).map_err(|_| err("MOBILE_JOURNAL_INVALID"))?;
        if ids.len() > 128 || ids.iter().any(|id| uuid::Uuid::parse_str(id).is_err()) {
            return Err(err("MOBILE_JOURNAL_INVALID"));
        }
        Ok(ids)
    }
    fn operations_pending(&self) -> Result<Value, NetworkError> {
        let Some(saved) = &self.saved else {
            return Ok(json!({"kind":"operations","items":[]}));
        };
        saved.session.validate(&saved.instance)?;
        let scope = journal_scope(&crate::KeyScope {
            issuer: saved.instance.issuer.clone(),
            environment: saved.instance.environment.clone(),
            service_id: saved.instance.service_id.clone(),
            principal_id: saved.session.principal_id.clone(),
            device_id: saved.device_id.clone(),
            key_generation: 1,
        })?;
        let mut items = Vec::new();
        for op in self.pending_operations(&scope)? {
            let Some(bytes) = self
                .store
                .read_record(&scope, &format!("operation:{op}"))
                .map_err(store_error)?
            else {
                continue;
            };
            let record: Value =
                serde_json::from_slice(&bytes).map_err(|_| err("MOBILE_JOURNAL_INVALID"))?;
            if record["confirmed"] == true {
                continue;
            }
            let request = journal_request(&record)?;
            let target: DeviceScope = serde_json::from_value(record["target"].clone())
                .map_err(|_| err("MOBILE_JOURNAL_INVALID"))?;
            if record["issuer"] != saved.instance.issuer
                || target.service_id != saved.instance.service_id
                || target.environment != saved.instance.environment
                || target.network_id != saved.instance.network_id
                || target.principal_id != saved.session.principal_id
                || request
                    .operation_id()
                    .map(|id| id.as_uuid().to_string())
                    .as_deref()
                    != Some(&op)
            {
                return Err(err("MOBILE_JOURNAL_INVALID"));
            }
            let id = self
                .targets
                .iter()
                .find(|(_, t)| t.device == target.device_id && t.agent == request.agent_id())
                .map(|(id, _)| id.as_str())
                .unwrap_or("");
            items.push(json!({"protocol":request.protocol(),"targetId":id,"agentId":request.agent_id(),"operationId":op,"sessionId":request.session_id(),"status":"unknown"}));
        }
        Ok(json!({"kind":"operations","items":items}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CryptoError, DevicePrivateKey, KeyScope};
    use std::sync::Mutex;
    #[derive(Default)]
    struct Store(Mutex<HashMap<String, Vec<u8>>>);
    impl IdentityStore for Store {
        fn load(&self, _: &KeyScope) -> Result<DevicePrivateKey, CryptoError> {
            Err(CryptoError::CredentialMissing)
        }
        fn save_pending(&self, _: &KeyScope, _: &DevicePrivateKey) -> Result<(), CryptoError> {
            Ok(())
        }
        fn delete(&self, _: &KeyScope) -> Result<(), CryptoError> {
            Ok(())
        }
    }
    impl SecureStore for Store {
        fn read_record(&self, s: &str, r: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
            Ok(self
                .0
                .lock()
                .unwrap()
                .get(&format!("{s}/{r}"))
                .cloned()
                .map(Zeroizing::new))
        }
        fn write_record(&self, s: &str, r: &str, v: &[u8]) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(format!("{s}/{r}"), v.to_vec());
            Ok(())
        }
        fn remove_record(&self, s: &str, r: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(&format!("{s}/{r}"));
            Ok(())
        }
    }
    pub(super) fn owner() -> MobileConnection {
        MobileConnection::new(
            NativeConfig {
                issuer: "https://mobile.example.test".into(),
                public_tls_ca: None,
            },
            Arc::new(Store::default()),
        )
        .unwrap()
    }
    #[test]
    fn journal_fences_accounts_but_survives_local_key_rotation() {
        let first = crate::KeyScope {
            issuer: "https://a.test".into(),
            environment: "development".into(),
            service_id: "service".into(),
            principal_id: "first".into(),
            device_id: "device".into(),
            key_generation: 1,
        };
        let mut rotated = first.clone();
        rotated.key_generation = 2;
        rotated.device_id = "new-login-device".into();
        assert_eq!(
            journal_scope(&first).unwrap(),
            journal_scope(&rotated).unwrap()
        );
        rotated.principal_id = "second".into();
        assert_ne!(
            journal_scope(&first).unwrap(),
            journal_scope(&rotated).unwrap()
        );
        rotated = first.clone();
        rotated.issuer = "https://b.test".into();
        assert_ne!(
            journal_scope(&first).unwrap(),
            journal_scope(&rotated).unwrap()
        );
    }
    #[test]
    fn corrupt_or_unbounded_pending_ledger_never_falls_back_to_empty() {
        let o = owner();
        o.store
            .write_record("scope", "pending-operations", b"not-json")
            .unwrap();
        assert!(o.pending_operations("scope").is_err());
        let ids = vec![uuid::Uuid::new_v4().to_string(); 129];
        o.store
            .write_record(
                "scope",
                "pending-operations",
                &serde_json::to_vec(&ids).unwrap(),
            )
            .unwrap();
        assert!(o.pending_operations("scope").is_err());
    }
    #[test]
    fn catalog_refresh_keeps_selection_only_for_the_same_device_and_agent() {
        let mut previous = HashMap::new();
        previous.insert(
            "approved-opaque".into(),
            Target {
                device: "host-one".into(),
                agent: "agent".into(),
            },
        );
        assert_eq!(
            catalog_target_id(&previous, "host-one", "agent"),
            "approved-opaque"
        );
        assert_ne!(
            catalog_target_id(&previous, "host-two", "agent"),
            "approved-opaque"
        );
        assert_ne!(
            catalog_target_id(&previous, "host-one", "another-agent"),
            "approved-opaque"
        );
        previous.clear();
        assert_ne!(
            catalog_target_id(&previous, "host-one", "agent"),
            "approved-opaque"
        );
    }
    #[test]
    fn pending_projection_exposes_only_scoped_receipt_identifiers() {
        let mut o = owner();
        let service = uuid::Uuid::new_v4().to_string();
        let principal = uuid::Uuid::new_v4().to_string();
        let network = uuid::Uuid::new_v4().to_string();
        let device = uuid::Uuid::new_v4().to_string();
        let remote = uuid::Uuid::new_v4().to_string();
        let instance = OwnedInstance {
            version: 1,
            profile: "owned-device-relay-v1".into(),
            service_id: service.clone(),
            environment: "development".into(),
            network_id: network.clone(),
            name: "Test".into(),
            issuer: o.config.issuer.clone(),
            login_issuer: "https://login.example.test/dex".into(),
            protocol: 1,
            capabilities: vec!["tls13-mtls".into()],
            root_certificate: String::new(),
            jwks: json!({"keys":[]}),
        };
        o.saved = Some(SavedAccount {
            device_id: device.clone(),
            session: OwnedSession {
                access_token: "a".repeat(43),
                expires_at: jsonwebtoken::get_current_timestamp() + 60,
                principal_id: principal.clone(),
                network_id: network.clone(),
            },
            instance,
        });
        let scope = journal_scope(&crate::KeyScope {
            issuer: o.config.issuer.clone(),
            service_id: service.clone(),
            environment: "development".into(),
            principal_id: principal.clone(),
            device_id: device,
            key_generation: 1,
        })
        .unwrap();
        let op = uuid::Uuid::new_v4().to_string();
        o.store
            .write_record(
                &scope,
                "pending-operations",
                &serde_json::to_vec(&vec![op.clone()]).unwrap(),
            )
            .unwrap();
        let record = json!({"issuer":o.config.issuer,"operationId":op,"digest":"private-digest","target":{"serviceId":service,"environment":"development","networkId":network,"principalId":principal,"deviceId":remote,"keyGeneration":1},"request":{"kind":"start","agentId":"agent","operationId":op,"text":"private-business-text"}});
        o.store
            .write_record(
                &scope,
                &format!("operation:{op}"),
                &serde_json::to_vec(&record).unwrap(),
            )
            .unwrap();
        let mobile_op = uuid::Uuid::new_v4().to_string();
        let mut mobile_record = record.clone();
        mobile_record["operationId"] = json!(mobile_op);
        mobile_record["request"] = json!({"kind":"mobile.send","version":1,"agentId":"agent","sessionId":"original-session","operationId":mobile_op,"text":"private-mobile-text","assetIds":[]});
        o.store
            .write_record(
                &scope,
                &format!("operation:{mobile_op}"),
                &serde_json::to_vec(&mobile_record).unwrap(),
            )
            .unwrap();
        o.store
            .write_record(
                &scope,
                "pending-operations",
                &serde_json::to_vec(&vec![op.clone(), mobile_op.clone()]).unwrap(),
            )
            .unwrap();
        o.targets.insert(
            "approved-catalog-id".into(),
            Target {
                device: remote,
                agent: "agent".into(),
            },
        );
        let reply = o.operations_pending().unwrap();
        assert_eq!(reply["items"][0]["targetId"], "approved-catalog-id");
        assert_eq!(reply["items"][0]["operationId"], op);
        assert_eq!(reply["items"][0]["protocol"], "session");
        assert_eq!(reply["items"][1]["protocol"], "mobile");
        assert_eq!(reply["items"][1]["operationId"], mobile_op);
        assert_eq!(reply["items"][1]["sessionId"], "original-session");
        assert!(!reply.to_string().contains("private"));
        o.targets.clear();
        assert_eq!(o.operations_pending().unwrap()["items"][0]["targetId"], "");
    }
    #[tokio::test]
    async fn exact_account_contract_and_startup_pending_projection() {
        let mut o = owner();
        assert_eq!(
            o.request(json!({"version":1,"kind":"account.login.poll"}))
                .await["error"]["code"],
            "OWNED_LOGIN_REQUIRED"
        );
        for kind in ["login.start", "login.poll", "logout"] {
            assert_eq!(
                o.request(json!({"version":1,"kind":kind})).await["error"]["code"],
                "MOBILE_INTENT_UNSUPPORTED"
            );
        }
        assert_eq!(
            o.request(json!({"version":1,"kind":"operations.pending"}))
                .await,
            json!({"ok":true,"value":{"kind":"operations","items":[]}})
        );
    }
    #[test]
    fn fresh_approval_requires_actionable_for_approve_but_preserves_explicit_deny() {
        let mut raw = json!({"kind":"respond","agentId":"agent","sessionId":"session","operationId":uuid::Uuid::new_v4().to_string(),"generation":"gen","turnId":"turn","requestId":"req","interaction":"permission","approved":true});
        let snapshot = json!({"kind":"snapshot","generation":"gen","turnId":"turn","interactions":[{"requestId":"req","generation":"gen","turnId":"turn","interaction":"permission","actionable":false}]});
        let request = serde_json::from_value(raw.clone()).unwrap();
        assert!(!approval_matches(&snapshot, &request));
        raw["approved"] = json!(false);
        let request = serde_json::from_value(raw).unwrap();
        assert!(approval_matches(&snapshot, &request));
        let mut stale = snapshot.clone();
        stale["turnId"] = json!("old");
        assert!(!approval_matches(&stale, &request));
    }
    #[tokio::test]
    async fn signed_out_status_requires_no_network_or_identity_fallback() {
        let mut o = owner();
        assert_eq!(
            o.request(json!({"version":1,"kind":"account.status"}))
                .await,
            json!({"ok":true,"value":{"kind":"account","state":"signed-out","displayName":null,"principalId":null}})
        );
    }
    #[tokio::test]
    async fn expired_login_destroys_verifier_and_never_polls() {
        let mut o = owner();
        o.pending = Some(PendingLogin {
            device: uuid::Uuid::new_v4().to_string(),
            verifier: Zeroizing::new("secret".into()),
            transaction: uuid::Uuid::new_v4().to_string(),
            expires: 1,
        });
        let value = o
            .request(json!({"version":1,"kind":"account.login.poll"}))
            .await;
        assert_eq!(value["error"]["code"], "OWNED_LOGIN_EXPIRED");
        assert!(o.pending.is_none());
        assert!(!value.to_string().contains("secret"));
    }
    #[tokio::test]
    async fn untrusted_intent_cannot_supply_credentials_or_endpoints() {
        let mut o = owner();
        for value in [
            json!({"version":1,"kind":"account.status","issuer":"https://evil.test"}),
            json!({"version":1,"kind":"session","targetId":"x","request":{},"accessToken":"secret"}),
            json!({"version":2,"kind":"account.logout"}),
        ] {
            assert_eq!(
                o.request(value).await["error"]["code"],
                "MOBILE_INTENT_INVALID"
            );
        }
    }
    #[tokio::test]
    async fn suspend_drops_targets_without_stopping_remote_owner() {
        let mut o = owner();
        o.targets.insert(
            "opaque".into(),
            Target {
                device: "device".into(),
                agent: "agent".into(),
            },
        );
        let value = o
            .request(json!({"version":1,"kind":"connection.suspend"}))
            .await;
        assert_eq!(value["value"]["state"], "suspended");
        assert!(o.targets.is_empty());
        assert!(o.active.load(Ordering::Acquire));
    }
    #[test]
    fn production_origin_is_https_without_path_or_redirect_destination() {
        for issuer in [
            "http://localhost",
            "https://owned.test/path",
            "https://user:secret@owned.test",
            "https://owned.test/?token=x",
        ] {
            assert!(MobileConnection::new(
                NativeConfig {
                    issuer: issuer.into(),
                    public_tls_ca: None
                },
                Arc::new(Store::default())
            )
            .is_err());
        }
    }
}

#[cfg(test)]
mod wss_tests {
    use super::*;
    #[tokio::test]
    async fn original_transport_uses_real_pinned_tls_upgrade_and_rejects_foreign_ca() {
        let leaf_key = rcgen::KeyPair::generate().unwrap();
        let cert = rcgen::CertificateParams::new(vec!["localhost".into()])
            .unwrap()
            .self_signed(&leaf_key)
            .unwrap();
        let server_config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            rustls::pki_types::PrivatePkcs8KeyDer::from(leaf_key.serialize_der()).into(),
        )
        .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config));
        let valid_acceptor = acceptor.clone();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let stream = valid_acceptor.accept(stream).await.unwrap();
            let callback=|request:&tokio_tungstenite::tungstenite::handshake::server::Request,mut response:tokio_tungstenite::tungstenite::handshake::server::Response|{
    assert_eq!(request.uri().path(),"/v1/ws");assert!(request.headers().contains_key("dpop"));assert_eq!(request.headers()["authorization"],"Bearer synthetic-public-token");response.headers_mut().insert("sec-websocket-protocol","myagents-agent-network.v1".parse().unwrap());Ok(response)
   };
            let mut ws = tokio_tungstenite::accept_hdr_async(stream, callback)
                .await
                .unwrap();
            assert_eq!(
                ws.next().await.unwrap().unwrap(),
                Message::Text("synthetic-ping".into())
            );
            ws.send(Message::Text("synthetic-pong".into()))
                .await
                .unwrap();
        });
        let key = Arc::new(crate::DevicePrivateKey::generate().unwrap());
        let transport = NetworkTransport::new_with_public_ca(
            &format!("https://localhost:{port}"),
            key.clone(),
            MemoryBudget::default(),
            Some(&cert.pem()),
        )
        .unwrap();
        let mut socket = tokio::time::timeout(
            Duration::from_secs(5),
            transport.websocket("synthetic-public-token"),
        )
        .await
        .unwrap()
        .unwrap();
        socket
            .send(Message::Text("synthetic-ping".into()))
            .await
            .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap(),
            Message::Text("synthetic-pong".into())
        );
        server.await.unwrap();
        // The same server certificate fails with unrelated test roots; no insecure
        // certificate verifier or plain WS fallback participates in this test.
        let other = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            acceptor.accept(stream).await.is_err()
        });
        let wrong = NetworkTransport::new_with_public_ca(
            &format!("https://localhost:{port}"),
            key,
            MemoryBudget::default(),
            Some(&other.cert.pem()),
        )
        .unwrap();
        assert!(tokio::time::timeout(
            Duration::from_secs(5),
            wrong.websocket("synthetic-public-token")
        )
        .await
        .unwrap()
        .is_err());
        assert!(server.await.unwrap());
    }
}
