//! One retained outer connection, TLS channel, credit and pair-sequence owner.
//! The relay allows one connection/device and one channel/pair. Both original
//! session.remote/v1 and versioned assets therefore multiplex typed request IDs.
use super::*;
use crate::agent_network::{
    account_operation::AccountOperation, identity::proof, transport::DeviceAddress,
};
use futures_util::FutureExt;
use moxbots_mobile_core::{Intent, MobileClient};
use myagents_host_management_protocol::{
    RemoteAssetRequest as Asset, RemoteMobileRequest as Mobile, RemoteSessionRequest as Session,
};
use std::time::Instant;
const ASSET_DEADLINE: Duration = Duration::from_secs(8);
const IDLE_LEASE: Duration = Duration::from_secs(20);
const FRAME_BYTES: usize = 64 * 1024;
const QUEUE_BYTES: usize = 256 * 1024;
fn sdk_error(code: String) -> NetworkError {
    NetworkError::cloud(&code, 400)
}

pub(super) struct PeerConnection {
    pub(super) c: Connected,
    pub(super) target: Target,
    address: DeviceAddress,
    sdk: MobileClient,
    channel: String,
    trust_expires_at: u64,
    created: Instant,
    last_use: Instant,
    assets_negotiated: bool,
    mobile_negotiated: bool,
}
impl PeerConnection {
    pub(super) fn reusable(&self, target: &Target, active: &Arc<AtomicBool>) -> bool {
        let NetworkAccountSession::Owned(account) = &self.c.identity.account else {
            return false;
        };
        same_owner(&self.target, target, &account.active, active)
            && self.c.identity.account.ensure_current().is_ok()
            && lease_live(
                self.created,
                self.last_use,
                self.trust_expires_at,
                jsonwebtoken::get_current_timestamp(),
            )
    }
    async fn open(mut c: Connected, target: Target, jwks: Value) -> Result<Self, NetworkError> {
        c.identity.account.ensure_current()?;
        c.identity = c.identity.clone().ensure_peer().await?;
        let address = c
            .transport
            .device_address(&c.identity.token, &c.local, &target.device)
            .await?;
        let mut verifier = c.identity.verifier.clone();
        let remote = verifier.peer(&address.signed_binding).await?;
        let key = c.identity.device_key();
        let signed = proof(
            &c.identity.account,
            &c.identity.scope,
            &key,
            "recover-query",
            &key.public_fingerprint()?,
        )
        .await?;
        let current=c.identity.account.request(AccountOperation::Current,Some(json!({"deviceId":c.identity.scope.device_id,"keyFingerprint":key.public_fingerprint()?,"expectedKeyGeneration":c.identity.scope.key_generation,"challengeId":signed.0,"proof":signed.1}))).await?;
        let bootstrap = current["bootstrapGrant"]
            .as_str()
            .ok_or_else(|| err("IDENTITY_RESPONSE_INVALID"))?;
        let verified = verifier.bootstrap(bootstrap).await?;
        c.identity
            .account
            .ensure_bootstrap(&verified.root_certificate, &verified.network_url)?;
        if verified.access.device_id != c.local.device_id
            || verified.access.key_generation != c.local.key_generation
            || verified.access.cnf.jkt != key.public_thumbprint()?
        {
            return Err(err("IDENTITY_SCOPE_MISMATCH"));
        }
        let peer = c
            .identity
            .peer
            .clone()
            .ok_or_else(|| err("NETWORK_CERTIFICATE_INVALID"))?;
        let deadline = (jsonwebtoken::get_current_timestamp() + 120)
            .min(c.identity.access.exp)
            .min(verified.access.exp)
            .min(peer.binding.expires_at)
            .min(remote.expires_at);
        if deadline <= jsonwebtoken::get_current_timestamp() + 8 {
            return Err(err("NETWORK_TOKEN_EXPIRED"));
        }
        let channel = uuid::Uuid::new_v4().to_string();
        send(
            &mut c.socket,
            ClientMessage::Open {
                scope: c.scope.clone(),
                channel_id: channel.clone(),
                target_device_id: address.scope.device_id.clone(),
                target_key_generation: address.scope.key_generation,
                target_connection_epoch: address.connection_epoch.clone(),
                target_binding: Some(address.signed_binding.clone()),
            },
        )
        .await?;
        let mut offered = false;
        let mut tls_initiator = false;
        let mut sdk = None;
        let mut relay_ready = false;
        let mut crypto_announced = false;
        loop {
            c.identity.account.ensure_current()?;
            if let Some(client) = sdk.as_mut() {
                flush(&mut c.socket, client).await?;
            }
            let message = read(&mut c.socket).await?;
            match message {
                Message::Ping(bytes) => c
                    .socket
                    .send(Message::Pong(bytes))
                    .await
                    .map_err(|_| err("NETWORK_CONNECTION_CLOSED"))?,
                Message::Pong(_) => {}
                Message::Text(text) => {
                    if text == "ma-network-pong" {
                        continue;
                    }
                    let envelope = ServerEnvelope::parse(text.as_bytes())
                        .map_err(|_| err("CONTROL_INVALID"))?;
                    if envelope
                        .message
                        .scope()
                        .is_some_and(|scope| scope != &c.scope)
                    {
                        return Err(err("CONTROL_SCOPE_MISMATCH"));
                    }
                    match envelope.message {
                        ServerMessage::ChannelOffer {
                            channel_id,
                            initiator,
                            responder,
                            initiator_connection_epoch,
                            responder_connection_epoch,
                            ..
                        } if channel_id == channel && !offered => {
                            tls_initiator = initiator == c.local;
                            let valid = if tls_initiator {
                                responder == address.scope
                                    && initiator_connection_epoch == c.scope.connection_epoch
                                    && responder_connection_epoch == address.connection_epoch
                            } else {
                                responder == c.local
                                    && initiator == address.scope
                                    && responder_connection_epoch == c.scope.connection_epoch
                                    && initiator_connection_epoch == address.connection_epoch
                            };
                            if !valid {
                                return Err(err("CHANNEL_SCOPE_MISMATCH"));
                            }
                            offered = true;
                            send(
                                &mut c.socket,
                                ClientMessage::Accept {
                                    scope: c.scope.clone(),
                                    channel_id: channel.clone(),
                                    signed_binding: peer.signed_binding.clone(),
                                },
                            )
                            .await?;
                        }
                        ServerMessage::ChannelAccepted {
                            channel_id,
                            initiator_binding,
                            responder_binding,
                            ..
                        } if channel_id == channel && offered && sdk.is_none() => {
                            let (local_binding, target_binding) = if tls_initiator {
                                (initiator_binding, responder_binding)
                            } else {
                                (responder_binding, initiator_binding)
                            };
                            if local_binding != peer.signed_binding
                                || target_binding != address.signed_binding
                            {
                                return Err(err("CHANNEL_SCOPE_MISMATCH"));
                            }
                            let config = json!({"profile":"combined","issuer":c.identity.account.issuer(),"local":c.local,"target":address.scope,"channelId":channel,"localEpoch":c.scope.connection_epoch,"targetEpoch":address.connection_epoch,"jwks":jwks,"bootstrap":bootstrap,"tlsInitiator":tls_initiator,"localSignedPeer":local_binding,"targetSignedPeer":target_binding,"certificate":peer.binding.certificate,"trustExpiresAt":deadline});
                            let pkcs8 =
                                key.with_native_pkcs8(|bytes| Zeroizing::new(bytes.to_vec()));
                            sdk = Some(
                                tokio::task::spawn_blocking(move || {
                                    let config = serde_json::from_value(config)
                                        .map_err(|_| "MOBILE_CONFIG_INVALID".to_owned())?;
                                    MobileClient::new(config, pkcs8)
                                })
                                .await
                                .map_err(|_| err("MOBILE_RUNTIME_UNAVAILABLE"))?
                                .map_err(sdk_error)?,
                            );
                        }
                        ServerMessage::ChannelReady { channel_id, .. }
                            if channel_id == channel && !relay_ready =>
                        {
                            sdk.as_mut()
                                .ok_or_else(|| err("CHANNEL_OFFER_MISSING"))?
                                .execute(Intent::RelayReady {})
                                .map_err(sdk_error)?;
                            relay_ready = true;
                        }
                        ServerMessage::Credit {
                            channel_id,
                            sequence,
                            received_bytes,
                            ..
                        } if channel_id == channel => sdk
                            .as_mut()
                            .ok_or_else(|| err("CHANNEL_OFFER_MISSING"))?
                            .relay_credit(sequence, received_bytes)
                            .map_err(sdk_error)?,
                        ServerMessage::Error { code, .. } => {
                            return Err(NetworkError::cloud(&code, 400))
                        }
                        _ => return Err(err("MOBILE_CHANNEL_CHANGED")),
                    }
                }
                Message::Binary(bytes) => {
                    let client = sdk.as_mut().ok_or_else(|| err("CHANNEL_OFFER_MISSING"))?;
                    let events = client.feed_frame(&bytes).map_err(sdk_error)?;
                    return_credit(&mut c, client, &channel).await?;
                    if events["events"]
                        .as_array()
                        .is_some_and(|values| values.iter().any(|v| v["kind"] != "ready"))
                    {
                        return Err(err("MOBILE_UNSOLICITED_RESPONSE"));
                    }
                }
                _ => return Err(err("NETWORK_CONNECTION_CLOSED")),
            }
            if let Some(client) = sdk.as_mut() {
                let status = client.execute(Intent::Status {}).map_err(sdk_error)?;
                if status["cryptoReady"] == true && !crypto_announced {
                    flush(&mut c.socket, client).await?;
                    send(
                        &mut c.socket,
                        ClientMessage::ChannelReady {
                            scope: c.scope.clone(),
                            channel_id: channel.clone(),
                        },
                    )
                    .await?;
                    crypto_announced = true;
                }
                if relay_ready && status["ready"] == true {
                    let sdk = sdk.take().ok_or_else(|| err("CHANNEL_OFFER_MISSING"))?;
                    return Ok(Self {
                        c,
                        target,
                        address,
                        sdk,
                        channel,
                        trust_expires_at: deadline,
                        created: Instant::now(),
                        last_use: Instant::now(),
                        assets_negotiated: false,
                        mobile_negotiated: false,
                    });
                }
            }
        }
    }
    async fn consume(&mut self, message: Message) -> Result<Value, NetworkError> {
        match message {
            Message::Ping(bytes) => {
                self.c
                    .socket
                    .send(Message::Pong(bytes))
                    .await
                    .map_err(|_| err("NETWORK_CONNECTION_CLOSED"))?;
            }
            Message::Pong(_) => {}
            Message::Text(text) => {
                if text == "ma-network-pong" {
                    return Ok(json!({"events":[]}));
                }
                if let Some((sequence, received_bytes)) =
                    control_credit(&text, &self.c.scope, &self.channel)?
                {
                    self.sdk
                        .relay_credit(sequence, received_bytes)
                        .map_err(sdk_error)?;
                }
            }
            Message::Binary(bytes) => {
                let events = self.sdk.feed_frame(&bytes).map_err(sdk_error)?;
                return_credit(&mut self.c, &mut self.sdk, &self.channel).await?;
                return Ok(events);
            }
            _ => return Err(err("NETWORK_CONNECTION_CLOSED")),
        }
        Ok(json!({"events":[]}))
    }
    pub(super) async fn drain_idle(&mut self) -> Result<(), NetworkError> {
        let mut queued = 0usize;
        for _ in 0..32 {
            let message = match self.c.socket.next().now_or_never() {
                Some(Some(Ok(message))) => message,
                Some(_) => return Err(err("NETWORK_CONNECTION_CLOSED")),
                None => {
                    flush(&mut self.c.socket, &mut self.sdk).await?;
                    return Ok(());
                }
            };
            check_frame(&message)?;
            queued += message.len();
            if queued > QUEUE_BYTES {
                return Err(err("MOBILE_ASSET_BACKPRESSURE"));
            }
            let events = self.consume(message).await?;
            if events["events"]
                .as_array()
                .is_some_and(|values| values.iter().any(|v| v["kind"] != "ready"))
            {
                return Err(err("MOBILE_UNSOLICITED_RESPONSE"));
            }
        }
        Err(err("MOBILE_ASSET_BACKPRESSURE"))
    }
    async fn response(
        &mut self,
        submitted: Value,
        event_kind: &str,
    ) -> Result<Value, NetworkError> {
        let request_id = submitted["requestId"]
            .as_str()
            .ok_or_else(|| err("MOBILE_REQUEST_INVALID"))?
            .to_owned();
        loop {
            self.c.identity.account.ensure_current()?;
            flush(&mut self.c.socket, &mut self.sdk).await?;
            let message = read(&mut self.c.socket).await?;
            let events = self.consume(message).await?;
            if let Some(values) = events["events"].as_array() {
                for event in values {
                    if event["kind"] == "ready" {
                        continue;
                    }
                    if event["requestId"] != request_id {
                        return Err(err("MOBILE_UNSOLICITED_RESPONSE"));
                    }
                    if event["kind"] == "error" {
                        return Err(NetworkError::cloud(
                            event["code"].as_str().unwrap_or("MOBILE_CHANNEL_CHANGED"),
                            400,
                        ));
                    }
                    if event["kind"] != event_kind {
                        return Err(err("MOBILE_PROFILE_MISMATCH"));
                    }
                    self.last_use = Instant::now();
                    return Ok(event["data"].clone());
                }
            }
        }
    }
    async fn mobile_rpc(&mut self, request: Mobile) -> Result<Value, NetworkError> {
        let submitted = self
            .sdk
            .execute(Intent::MobileRequest { request })
            .map_err(sdk_error)?;
        self.response(submitted, "mobile-response").await
    }
    async fn asset_rpc(&mut self, request: Asset) -> Result<Value, NetworkError> {
        let submitted = self
            .sdk
            .execute(Intent::AssetRequest { request })
            .map_err(sdk_error)?;
        self.response(submitted, "asset-response").await
    }
}
fn same_owner(
    expected: &Target,
    target: &Target,
    owner: &Arc<AtomicBool>,
    active: &Arc<AtomicBool>,
) -> bool {
    expected == target && Arc::ptr_eq(owner, active) && owner.load(Ordering::Acquire)
}
fn lease_live(created: Instant, last_use: Instant, expires: u64, now: u64) -> bool {
    created.elapsed() < Duration::from_secs(110)
        && last_use.elapsed() < IDLE_LEASE
        && expires > now.saturating_add(8)
}
fn control_credit(
    text: &str,
    scope: &ConnectionScope,
    channel: &str,
) -> Result<Option<(u64, u64)>, NetworkError> {
    let envelope = ServerEnvelope::parse(text.as_bytes()).map_err(|_| err("CONTROL_INVALID"))?;
    if envelope
        .message
        .scope()
        .is_some_and(|current| current != scope)
    {
        return Err(err("CONTROL_SCOPE_MISMATCH"));
    }
    match envelope.message {
        ServerMessage::Credit {
            channel_id,
            sequence,
            received_bytes,
            ..
        } if channel_id == channel => Ok(Some((sequence, received_bytes))),
        ServerMessage::Error { code, .. } => Err(NetworkError::cloud(&code, 400)),
        ServerMessage::Changed { .. } => Err(err("MOBILE_POLICY_CHANGED")),
        ServerMessage::ChannelClosed { .. } => Err(err("MOBILE_CHANNEL_CLOSED")),
        _ => Err(err("MOBILE_CHANNEL_CHANGED")),
    }
}
fn check_frame(message: &Message) -> Result<(), NetworkError> {
    if message.len()
        > FRAME_BYTES
            + if matches!(message, Message::Binary(_)) {
                22
            } else {
                0
            }
    {
        Err(err("MOBILE_FRAME_TOO_LARGE"))
    } else {
        Ok(())
    }
}
async fn read(socket: &mut NetworkSocket) -> Result<Message, NetworkError> {
    let message = socket
        .next()
        .await
        .ok_or_else(|| err("NETWORK_CONNECTION_CLOSED"))?
        .map_err(|_| err("NETWORK_CONNECTION_CLOSED"))?;
    check_frame(&message)?;
    Ok(message)
}
async fn flush(socket: &mut NetworkSocket, sdk: &mut MobileClient) -> Result<(), NetworkError> {
    let mut bytes = 0usize;
    while let Some(frame) = sdk.drain_frame().map_err(sdk_error)? {
        bytes += frame.len();
        if bytes > QUEUE_BYTES {
            return Err(err("MOBILE_ASSET_BACKPRESSURE"));
        }
        socket
            .send(Message::Binary(frame))
            .await
            .map_err(|_| err("NETWORK_CONNECTION_CLOSED"))?;
    }
    Ok(())
}
async fn return_credit(
    c: &mut Connected,
    sdk: &mut MobileClient,
    channel: &str,
) -> Result<(), NetworkError> {
    if let Some((sequence, received_bytes)) = sdk.take_received_credit().map_err(sdk_error)? {
        send(
            &mut c.socket,
            ClientMessage::Credit {
                scope: c.scope.clone(),
                channel_id: channel.into(),
                sequence,
                received_bytes,
            },
        )
        .await?;
    }
    Ok(())
}

impl MobileConnection {
    fn approved_target(&self, intent: &Value) -> Result<Target, NetworkError> {
        self.targets
            .get(
                intent["targetId"]
                    .as_str()
                    .ok_or_else(|| err("MOBILE_TARGET_INVALID"))?,
            )
            .cloned()
            .ok_or_else(|| err("MOBILE_TARGET_INVALID"))
    }
    async fn retained_peer(&mut self, target: &Target) -> Result<PeerConnection, NetworkError> {
        self.restore().await?;
        let saved = self
            .saved
            .as_ref()
            .ok_or_else(|| err("OWNED_LOGIN_REQUIRED"))?;
        self.client
            .as_ref()
            .ok_or_else(|| err("OWNED_LOGIN_REQUIRED"))?
            .validate_session(&saved.device_id, &saved.session)
            .await?;
        if let Some(mut peer) = self.peer.take() {
            if peer.reusable(target, &self.active) {
                match peer.drain_idle().await {
                    Ok(()) => {
                        let fresh = peer
                            .c
                            .transport
                            .device_address(&peer.c.identity.token, &peer.c.local, &target.device)
                            .await?;
                        if fresh != peer.address {
                            return Err(err("HOST_MANAGEMENT_TARGET_CHANGED"));
                        }
                        return Ok(peer);
                    }
                    Err(error) if error.code == "NETWORK_CONNECTION_CLOSED" => {}
                    Err(error) => return Err(error),
                }
            }
        }
        self.connected = None;
        let c = self.new_connection().await?;
        let jwks = self
            .instance
            .as_ref()
            .ok_or_else(|| err("NETWORK_TRUST_CHANGED"))?
            .jwks
            .clone();
        let mut peer = PeerConnection::open(c, target.clone(), jwks).await?;
        self.recover_peer(&mut peer)?;
        Ok(peer)
    }
    fn recover_peer(&self, peer: &mut PeerConnection) -> Result<(), NetworkError> {
        let scope = journal_scope(&peer.c.identity.scope)?;
        let records = self.recovery_records(&scope, &peer.address.scope, &peer.target.agent)?;
        peer.sdk
            .execute(Intent::Recover { records })
            .map_err(sdk_error)?;
        Ok(())
    }
    fn recovery_records(
        &self,
        scope: &str,
        target: &DeviceScope,
        agent: &str,
    ) -> Result<Vec<JournalRecord>, NetworkError> {
        let mut records = Vec::new();
        for id in self.pending_operations(scope)? {
            let Some(bytes) = self
                .store
                .read_record(scope, &format!("operation:{id}"))
                .map_err(store_error)?
            else {
                continue;
            };
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| err("MOBILE_JOURNAL_INVALID"))?;
            if value["confirmed"] == true {
                continue;
            }
            let request = journal_request(&value)?;
            if request
                .operation_id()
                .map(|op| op.as_uuid().to_string())
                .as_deref()
                != Some(&id)
            {
                return Err(err("MOBILE_JOURNAL_INVALID"));
            }
            if request.agent_id() == agent
                && value["target"]
                    == serde_json::to_value(target).map_err(|_| err("MOBILE_JOURNAL_INVALID"))?
                && value["issuer"] == self.config.issuer
            {
                records.push(
                    serde_json::from_value(value).map_err(|_| err("MOBILE_JOURNAL_INVALID"))?,
                );
            }
        }
        Ok(records)
    }
    pub(super) async fn mobile(&mut self, intent: &Value) -> Result<Value, NetworkError> {
        if serde_json::to_vec(intent)
            .map_err(|_| err("MOBILE_INTENT_INVALID"))?
            .len()
            > 64 * 1024
        {
            return Err(err("MOBILE_INTENT_INVALID"));
        }
        let target = self.approved_target(intent)?;
        let request: Mobile = serde_json::from_value(intent["request"].clone())
            .map_err(|_| err("MOBILE_INTENT_INVALID"))?;
        request
            .validate()
            .map_err(|_| err("MOBILE_INTENT_INVALID"))?;
        if request.agent_id() != target.agent {
            return Err(err("MOBILE_TARGET_INVALID"));
        }
        match tokio::time::timeout(Duration::from_secs(35), self.mobile_inner(target, request))
            .await
        {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => {
                self.peer = None;
                self.connected = None;
                Err(error)
            }
            Err(_) => {
                self.peer = None;
                self.connected = None;
                Err(err("MOBILE_SESSION_UNKNOWN"))
            }
        }
    }
    async fn mobile_inner(
        &mut self,
        target: Target,
        request: Mobile,
    ) -> Result<Value, NetworkError> {
        let mut peer = self.retained_peer(&target).await?;
        // Recovery ran before the SDK owner's first RPC, including capabilities.
        if !peer.mobile_negotiated && !matches!(request, Mobile::Capabilities { .. }) {
            let caps = peer
                .mobile_rpc(Mobile::Capabilities {
                    version: 1,
                    agent_id: target.agent.clone(),
                })
                .await?;
            if caps["kind"] != "mobile.capabilities" {
                self.peer = Some(peer);
                return Ok(caps);
            }
            peer.mobile_negotiated = true;
        }
        let wrapped = JournalRequest::Mobile(request.clone());
        let submitted = if request.mutation() {
            self.queue_journal(&mut peer, &wrapped)?
        } else {
            peer.sdk
                .execute(Intent::MobileRequest {
                    request: request.clone(),
                })
                .map_err(sdk_error)?
        };
        let data = peer.response(submitted, "mobile-response").await?;
        if matches!(request, Mobile::Capabilities { .. }) && data["kind"] == "mobile.capabilities" {
            peer.mobile_negotiated = true;
        }
        self.settle_journal(
            &journal_scope(&peer.c.identity.scope)?,
            &peer.address.scope,
            &wrapped,
            &data,
        )?;
        self.peer = Some(peer);
        Ok(data)
    }
    pub(super) async fn session(&mut self, intent: &Value) -> Result<Value, NetworkError> {
        let target = self.approved_target(intent)?;
        let request: Session = serde_json::from_value(intent["request"].clone())
            .map_err(|_| err("MOBILE_INTENT_INVALID"))?;
        request
            .validate()
            .map_err(|_| err("MOBILE_INTENT_INVALID"))?;
        if request.agent_id() != target.agent {
            return Err(err("MOBILE_TARGET_INVALID"));
        }
        match tokio::time::timeout(Duration::from_secs(35), self.session_inner(target, request))
            .await
        {
            Ok(Err(error)) => {
                self.peer = None;
                self.connected = None;
                Err(error)
            }
            Ok(Ok(value)) => Ok(value),
            Err(_) => {
                self.peer = None;
                self.connected = None;
                Err(err("MOBILE_SESSION_UNKNOWN"))
            }
        }
    }
    async fn session_inner(
        &mut self,
        target: Target,
        request: Session,
    ) -> Result<Value, NetworkError> {
        let mut peer = self.retained_peer(&target).await?;
        if let Session::Respond {
            agent_id,
            session_id,
            ..
        } = &request
        {
            let get = Session::Get {
                agent_id: agent_id.clone(),
                session_id: session_id.clone(),
                limit: 1,
                before: None,
            };
            let submitted = self.queue_session(&mut peer, &get)?;
            let snapshot = peer.response(submitted, "response").await?;
            if !approval_matches(&snapshot, &request) {
                return Err(err("MOBILE_APPROVAL_STALE"));
            }
        }
        let submitted = self.queue_session(&mut peer, &request)?;
        let data = peer.response(submitted, "response").await?;
        self.settle_session(&peer, &request, &data)?;
        self.peer = Some(peer);
        Ok(data)
    }
    fn queue_session(
        &self,
        peer: &mut PeerConnection,
        request: &Session,
    ) -> Result<Value, NetworkError> {
        if !request.mutation() {
            return peer
                .sdk
                .execute(Intent::Request {
                    request: request.clone(),
                })
                .map_err(sdk_error);
        }
        self.queue_journal(peer, &JournalRequest::Legacy(request.clone()))
    }
    fn write_journal(&self, scope: &str, key: &str, bytes: &[u8]) -> Result<(), NetworkError> {
        self.store
            .write_record(scope, key, bytes)
            .map_err(store_error)?;
        let read = self.store.read_record(scope, key).map_err(store_error)?;
        if read.as_deref().map(|b| b.as_slice()) != Some(bytes) {
            return Err(err("MOBILE_JOURNAL_PERSISTENCE_UNCONFIRMED"));
        }
        Ok(())
    }
    fn queue_journal(
        &self,
        peer: &mut PeerConnection,
        request: &JournalRequest,
    ) -> Result<Value, NetworkError> {
        let op = request
            .operation_id()
            .ok_or_else(|| err("MOBILE_OPERATION_REQUIRED"))?
            .as_uuid()
            .to_string();
        let record = format!("operation:{op}");
        let scope = journal_scope(&peer.c.identity.scope)?;
        if self
            .store
            .read_record(&scope, &record)
            .map_err(store_error)?
            .is_some()
        {
            return Err(err("MOBILE_RECEIPT_REQUIRED"));
        }
        let mut pending = self.pending_operations(&scope)?;
        if !pending.contains(&op) {
            if pending.len() >= 128 {
                return Err(err("MOBILE_JOURNAL_LIMIT"));
            }
            pending.push(op.clone());
            self.write_journal(
                &scope,
                "pending-operations",
                &serde_json::to_vec(&pending).map_err(|_| err("MOBILE_JOURNAL_INVALID"))?,
            )?;
        }
        let prepare = match request {
            JournalRequest::Legacy(r) => Intent::Prepare { request: r.clone() },
            JournalRequest::Mobile(r) => Intent::PrepareMobile { request: r.clone() },
        };
        let prepared = peer.sdk.execute(prepare).map_err(sdk_error)?;
        let bytes = Zeroizing::new(
            serde_json::to_vec(&prepared["record"]).map_err(|_| err("MOBILE_JOURNAL_INVALID"))?,
        );
        self.write_journal(&scope, &record, &bytes)?;
        peer.sdk
            .execute(
                serde_json::from_value(
                    json!({"kind":"commit","operationId":op,"digest":prepared["record"]["digest"]}),
                )
                .map_err(|_| err("MOBILE_INTENT_INVALID"))?,
            )
            .map_err(sdk_error)
    }
    fn settle_session(
        &self,
        peer: &PeerConnection,
        request: &Session,
        data: &Value,
    ) -> Result<(), NetworkError> {
        self.settle_journal(
            &journal_scope(&peer.c.identity.scope)?,
            &peer.address.scope,
            &JournalRequest::Legacy(request.clone()),
            data,
        )
    }
    fn settle_journal(
        &self,
        scope: &str,
        target: &DeviceScope,
        request: &JournalRequest,
        data: &Value,
    ) -> Result<(), NetworkError> {
        let receipt = if request.protocol() == "mobile" {
            "mobile.receipt"
        } else {
            "receipt"
        };
        let settled =
            request.protocol() == "session" && request.mutation() && data["kind"] == "snapshot"
                || data["kind"] == receipt
                    && ["accepted", "rejected"]
                        .iter()
                        .any(|status| data["status"] == *status);
        if !settled {
            return Ok(());
        }
        let Some(id) = request.operation_id() else {
            return Ok(());
        };
        let op = id.as_uuid().to_string();
        let key = format!("operation:{op}");
        let Some(bytes) = self.store.read_record(scope, &key).map_err(store_error)? else {
            return Ok(());
        };
        let stored: Value =
            serde_json::from_slice(&bytes).map_err(|_| err("MOBILE_JOURNAL_INVALID"))?;
        if stored["confirmed"] == true {
            return Ok(());
        }
        let prior = journal_request(&stored)?;
        // A valid response for another protocol may not settle this protocol's
        // operation, even when the caller deliberately reuses its UUID.
        if prior.protocol() != request.protocol() {
            return Ok(());
        }
        if prior.operation_id() != Some(id)
            || prior.agent_id() != request.agent_id()
            || stored["issuer"] != self.config.issuer
            || stored["target"]
                != serde_json::to_value(target).map_err(|_| err("MOBILE_JOURNAL_INVALID"))?
        {
            return Err(err("MOBILE_JOURNAL_INVALID"));
        }
        if data["kind"] == receipt
            && (data["operationId"] != op || data["agentId"] != prior.agent_id())
        {
            return Err(err("MOBILE_RESPONSE_SCOPE_MISMATCH"));
        }
        if let JournalRequest::Mobile(Mobile::Send { session_id, .. }) = &prior {
            if data["sessionId"] != *session_id {
                return Err(err("MOBILE_RESPONSE_SCOPE_MISMATCH"));
            }
        }
        self.write_journal(scope, &key, b"{\"confirmed\":true}")?;
        let mut pending = self.pending_operations(scope)?;
        pending.retain(|id| id != &op);
        self.write_journal(
            scope,
            "pending-operations",
            &serde_json::to_vec(&pending).map_err(|_| err("MOBILE_JOURNAL_INVALID"))?,
        )
    }
    pub(super) async fn assets(&mut self, intent: &Value) -> Result<Value, NetworkError> {
        let target = self.approved_target(intent)?;
        let request: Asset = serde_json::from_value(intent["request"].clone())
            .map_err(|_| err("MOBILE_ASSET_REQUEST_INVALID"))?;
        request
            .validate()
            .map_err(|_| err("MOBILE_ASSET_REQUEST_INVALID"))?;
        if request.agent_id() != target.agent {
            return Err(err("MOBILE_TARGET_INVALID"));
        }
        match tokio::time::timeout(ASSET_DEADLINE, self.assets_inner(target, request)).await {
            Ok(Err(error)) => {
                self.peer = None;
                self.connected = None;
                Err(error)
            }
            Ok(Ok(value)) => Ok(value),
            Err(_) => {
                self.peer = None;
                self.connected = None;
                Err(err("MOBILE_ASSET_UNKNOWN"))
            }
        }
    }
    async fn assets_inner(
        &mut self,
        target: Target,
        request: Asset,
    ) -> Result<Value, NetworkError> {
        let mut peer = self.retained_peer(&target).await?;
        let key = asset_upload_key(&target, &request);
        let scope = journal_scope(&peer.c.identity.scope)?;
        if let Some(key) = &key {
            if !matches!(request, Asset::UploadStatus { .. })
                && self
                    .store
                    .read_record(&scope, key)
                    .map_err(store_error)?
                    .is_some()
            {
                return Err(err("MOBILE_ASSET_STATUS_REQUIRED"));
            }
        }
        if !peer.assets_negotiated && !matches!(request, Asset::Capabilities { .. }) {
            let caps = peer
                .asset_rpc(Asset::Capabilities {
                    version: 1,
                    agent_id: target.agent.clone(),
                })
                .await?;
            if caps["kind"] != "capabilities" || caps["version"] != 1 {
                self.peer = Some(peer);
                return Ok(caps);
            }
            peer.assets_negotiated = true;
        }
        if let Some(key) = &key {
            if !matches!(request, Asset::UploadStatus { .. }) {
                self.mark_asset_unknown(&scope, key)?;
            }
        }
        let result = peer.asset_rpc(request.clone()).await?;
        if matches!(request, Asset::Capabilities { .. })
            && result["kind"] == "capabilities"
            && result["version"] == 1
        {
            peer.assets_negotiated = true;
        }
        if let Some(key) = &key {
            if resolves_upload_uncertainty(&request, &result) {
                self.clear_asset_unknown(&scope, key)?;
            }
        }
        self.peer = Some(peer);
        Ok(result)
    }
    fn asset_unknown_index(&self, scope: &str) -> Result<Vec<String>, NetworkError> {
        let Some(bytes) = self
            .store
            .read_record(scope, "asset-unknown-uploads")
            .map_err(store_error)?
        else {
            return Ok(vec![]);
        };
        let values: Vec<String> =
            serde_json::from_slice(&bytes).map_err(|_| err("MOBILE_JOURNAL_INVALID"))?;
        if values.len() > 128
            || values
                .iter()
                .any(|s| s.len() != 78 || !s.starts_with("asset-unknown:"))
        {
            return Err(err("MOBILE_JOURNAL_INVALID"));
        }
        Ok(values)
    }
    fn mark_asset_unknown(&self, scope: &str, key: &str) -> Result<(), NetworkError> {
        let mut pending = self.asset_unknown_index(scope)?;
        if !pending.iter().any(|id| id == key) {
            if pending.len() >= 128 {
                return Err(err("MOBILE_ASSET_JOURNAL_LIMIT"));
            }
            pending.push(key.into());
        }
        self.store
            .write_record(
                scope,
                "asset-unknown-uploads",
                &serde_json::to_vec(&pending).map_err(|_| err("MOBILE_JOURNAL_INVALID"))?,
            )
            .map_err(store_error)?;
        self.store
            .write_record(scope, key, b"unknown-status-required")
            .map_err(store_error)
    }
    fn clear_asset_unknown(&self, scope: &str, key: &str) -> Result<(), NetworkError> {
        self.store.remove_record(scope, key).map_err(store_error)?;
        let mut pending = self.asset_unknown_index(scope)?;
        pending.retain(|id| id != key);
        self.store
            .write_record(
                scope,
                "asset-unknown-uploads",
                &serde_json::to_vec(&pending).map_err(|_| err("MOBILE_JOURNAL_INVALID"))?,
            )
            .map_err(store_error)
    }
}
fn resolves_upload_uncertainty(request: &Asset, result: &Value) -> bool {
    if result["version"] != 1 {
        return false;
    }
    if result["kind"] == "error" {
        return matches!(request, Asset::UploadStatus { .. })
            && result["code"] == "ASSET_NOT_FOUND";
    }
    result["agentId"] == request.agent_id()
        && ["upload", "asset"]
            .iter()
            .any(|kind| result["kind"] == *kind)
}
fn asset_upload_key(target: &Target, request: &Asset) -> Option<String> {
    let id = match request {
        Asset::UploadBegin { upload_id, .. }
        | Asset::UploadChunk { upload_id, .. }
        | Asset::UploadStatus { upload_id, .. }
        | Asset::UploadFinish { upload_id, .. }
        | Asset::UploadCancel { upload_id, .. } => upload_id,
        _ => return None,
    };
    let value = serde_json::to_vec(&(target.device.as_str(), target.agent.as_str(), id)).ok()?;
    Some(format!("asset-unknown:{:x}", Sha256::digest(value)))
}

#[cfg(test)]
mod tests {
    use super::super::tests::owner;
    use super::*;
    use myagents_host_management_protocol::CanonicalUuid;
    fn target() -> Target {
        Target {
            device: "00000000-0000-0000-0000-000000000001".into(),
            agent: "agent".into(),
        }
    }
    fn status(id: CanonicalUuid) -> Asset {
        Asset::UploadStatus {
            version: 1,
            agent_id: "agent".into(),
            upload_id: id,
        }
    }
    #[test]
    fn ambiguous_upload_journal_is_scoped_bounded_and_only_status_resolves_missing() {
        let o = owner();
        let id = CanonicalUuid::new(uuid::Uuid::new_v4());
        let request = status(id);
        let key = asset_upload_key(&target(), &request).unwrap();
        o.mark_asset_unknown("principal-one", &key).unwrap();
        assert!(o
            .store
            .read_record("principal-one", &key)
            .unwrap()
            .is_some());
        assert!(o
            .store
            .read_record("principal-two", &key)
            .unwrap()
            .is_none());
        let mut another = target();
        another.agent = "other".into();
        assert_ne!(asset_upload_key(&another, &request).unwrap(), key);
        assert!(!resolves_upload_uncertainty(
            &request,
            &json!({"kind":"error","version":1,"code":"NETWORK_UNAVAILABLE"})
        ));
        assert!(!resolves_upload_uncertainty(
            &request,
            &json!({"kind":"error","version":2,"code":"ASSET_NOT_FOUND"})
        ));
        assert!(resolves_upload_uncertainty(
            &request,
            &json!({"kind":"error","version":1,"code":"ASSET_NOT_FOUND"})
        ));
        let chunk = Asset::UploadChunk {
            version: 1,
            agent_id: "agent".into(),
            upload_id: id,
            offset: 0,
            data_base64: "YQ==".into(),
            sha256: format!("{:x}", Sha256::digest(b"a")),
        };
        assert_eq!(asset_upload_key(&target(), &chunk).unwrap(), key);
        assert!(!resolves_upload_uncertainty(
            &chunk,
            &json!({"kind":"error","version":1,"code":"ASSET_NOT_FOUND"})
        ));
        o.clear_asset_unknown("principal-one", &key).unwrap();
        assert!(o.asset_unknown_index("principal-one").unwrap().is_empty());
        for n in 0..128 {
            o.mark_asset_unknown("bounded", &format!("asset-unknown:{n:064x}"))
                .unwrap();
        }
        assert_eq!(
            o.mark_asset_unknown("bounded", &format!("asset-unknown:{:064x}", 128))
                .unwrap_err()
                .code,
            "MOBILE_ASSET_JOURNAL_LIMIT"
        );
    }
    fn journal_record(request: Value, target: &DeviceScope, issuer: &str) -> Value {
        let request: JournalRequest = serde_json::from_value(request).unwrap();
        let digest = URL_SAFE_NO_PAD.encode(Sha256::digest(
            serde_json::to_vec(&(issuer, target, &request)).unwrap(),
        ));
        json!({"operationId":request.operation_id().unwrap(),"digest":digest,"request":request,"target":target,"issuer":issuer})
    }
    #[test]
    fn native_recovery_accepts_frozen_legacy_and_mobile_without_rewriting_bytes() {
        let mut o = owner();
        let legacy: Value = serde_json::from_slice(include_bytes!(
            "../../core/tests/fixtures/legacy-journal-v1.json"
        ))
        .unwrap();
        o.config.issuer = legacy["issuer"].as_str().unwrap().into();
        let target: DeviceScope = serde_json::from_value(legacy["target"].clone()).unwrap();
        let op = uuid::Uuid::new_v4().to_string();
        let mobile = journal_record(
            json!({"kind":"mobile.send","version":1,"agentId":"agent","operationId":op,"sessionId":"session","text":"secret","assetIds":[]}),
            &target,
            &o.config.issuer,
        );
        let ids = vec![
            legacy["operationId"].as_str().unwrap().to_owned(),
            op.clone(),
        ];
        o.write_journal(
            "scope",
            "pending-operations",
            &serde_json::to_vec(&ids).unwrap(),
        )
        .unwrap();
        for record in [&legacy, &mobile] {
            o.write_journal(
                "scope",
                &format!("operation:{}", record["operationId"].as_str().unwrap()),
                &serde_json::to_vec(record).unwrap(),
            )
            .unwrap();
        }
        let restored = o.recovery_records("scope", &target, "agent").unwrap();
        assert_eq!(restored.len(), 2);
        assert_eq!(serde_json::to_value(&restored[0]).unwrap(), legacy);
        assert_eq!(serde_json::to_value(&restored[1]).unwrap(), mobile);
        assert!(o
            .recovery_records("scope", &target, "other-agent")
            .unwrap()
            .is_empty());
        let mut changed = target.clone();
        changed.key_generation += 1;
        assert!(o
            .recovery_records("scope", &changed, "agent")
            .unwrap()
            .is_empty());
        assert_eq!(o.pending_operations("scope").unwrap(), ids);
        assert_eq!(
            o.store
                .read_record("scope", &format!("operation:{op}"))
                .unwrap()
                .unwrap()
                .as_slice(),
            serde_json::to_vec(&mobile).unwrap()
        );
    }
    #[test]
    fn native_settlement_keeps_unknown_and_foreign_protocol_and_original_session() {
        let o = owner();
        let op = uuid::Uuid::new_v4().to_string();
        let target:DeviceScope=serde_json::from_value(json!({"serviceId":uuid::Uuid::new_v4().to_string(),"environment":"development","networkId":uuid::Uuid::new_v4().to_string(),"principalId":"principal","deviceId":target().device,"keyGeneration":1})).unwrap();
        let mobile = journal_record(
            json!({"kind":"mobile.send","version":1,"agentId":"agent","operationId":op,"sessionId":"original","text":"secret","assetIds":[]}),
            &target,
            &o.config.issuer,
        );
        let original = serde_json::to_vec(&mobile).unwrap();
        let key = format!("operation:{op}");
        o.write_journal(
            "scope",
            "pending-operations",
            &serde_json::to_vec(&vec![op.clone()]).unwrap(),
        )
        .unwrap();
        o.write_journal("scope", &key, &original).unwrap();
        let query: JournalRequest = serde_json::from_value(
            json!({"kind":"mobile.receipt","version":1,"agentId":"agent","operationId":op}),
        )
        .unwrap();
        let legacy: JournalRequest =
            serde_json::from_value(json!({"kind":"receipt","agentId":"agent","operationId":op}))
                .unwrap();
        let accepted = json!({"kind":"mobile.receipt","version":1,"agentId":"agent","operationId":op,"sessionId":"original","status":"accepted","code":null});
        for status in ["unknown", "processing", "not-found", "unconfirmed"] {
            let mut result = accepted.clone();
            result["status"] = json!(status);
            o.settle_journal("scope", &target, &query, &result).unwrap();
            assert_eq!(
                o.store
                    .read_record("scope", &key)
                    .unwrap()
                    .unwrap()
                    .as_slice(),
                original
            );
        }
        let mut wrong_protocol = accepted.clone();
        wrong_protocol["kind"] = json!("receipt");
        o.settle_journal("scope", &target, &legacy, &wrong_protocol)
            .unwrap();
        assert_eq!(
            o.store
                .read_record("scope", &key)
                .unwrap()
                .unwrap()
                .as_slice(),
            original
        );
        let mut wrong_session = accepted.clone();
        wrong_session["sessionId"] = json!("foreign");
        assert_eq!(
            o.settle_journal("scope", &target, &query, &wrong_session)
                .unwrap_err()
                .code,
            "MOBILE_RESPONSE_SCOPE_MISMATCH"
        );
        o.settle_journal("scope", &target, &query, &accepted)
            .unwrap();
        assert!(o.pending_operations("scope").unwrap().is_empty());
        assert_eq!(
            o.store
                .read_record("scope", &key)
                .unwrap()
                .unwrap()
                .as_slice(),
            b"{\"confirmed\":true}"
        );
        // The inverse protocol direction cannot settle an original legacy op.
        let legacy_record = journal_record(
            json!({"kind":"start","agentId":"agent","operationId":op,"text":"legacy"}),
            &target,
            &o.config.issuer,
        );
        o.write_journal("scope", &key, &serde_json::to_vec(&legacy_record).unwrap())
            .unwrap();
        o.settle_journal("scope", &target, &query, &accepted)
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&o.store.read_record("scope", &key).unwrap().unwrap())
                .unwrap(),
            legacy_record
        );
    }
    #[test]
    fn native_journal_requires_exact_os_write_confirmation() {
        let memory = Box::<crate::ffi::tests::Memory>::default();
        let o = MobileConnection::new(
            NativeConfig {
                issuer: "https://test.example".into(),
                public_tls_ca: None,
            },
            Arc::new(crate::ffi::tests::callbacks(&memory)),
        )
        .unwrap();
        memory.discard.store(true, Ordering::SeqCst);
        assert_eq!(
            o.write_journal("scope", "pending-operations", b"[]")
                .unwrap_err()
                .code,
            "MOBILE_JOURNAL_PERSISTENCE_UNCONFIRMED"
        );
        memory.discard.store(false, Ordering::SeqCst);
        o.write_journal("scope", "record", b"original").unwrap();
        memory.discard.store(true, Ordering::SeqCst);
        assert_eq!(
            o.write_journal("scope", "record", b"changed")
                .unwrap_err()
                .code,
            "MOBILE_JOURNAL_PERSISTENCE_UNCONFIRMED"
        );
    }
    #[tokio::test]
    async fn mobile_requires_current_catalog_agent_and_real_account_without_fallback() {
        let mut o = owner();
        o.targets.insert("approved".into(), target());
        for (agent, expected) in [
            ("foreign", "MOBILE_TARGET_INVALID"),
            ("agent", "OWNED_LOGIN_REQUIRED"),
        ] {
            let result=o.request(json!({"version":1,"kind":"mobile","targetId":"approved","request":{"kind":"mobile.capabilities","version":1,"agentId":agent}})).await;
            assert_eq!(result["error"]["code"], expected);
        }
        let result=o.request(json!({"version":1,"kind":"mobile","targetId":"approved","request":{"kind":"mobile.start","version":1,"agentId":"agent","operationId":uuid::Uuid::new_v4().to_string(),"assetIds":[],"text":"x".repeat(16001)}})).await;
        assert_eq!(result["error"]["code"], "MOBILE_INTENT_INVALID");
        assert!(o.peer.is_none());
    }
    #[tokio::test]
    async fn assets_require_approved_agent_and_real_account_before_any_network_effect() {
        let mut o = owner();
        o.targets.insert("approved".into(), target());
        let result=o.request(json!({"version":1,"kind":"assets","targetId":"approved","request":{"kind":"capabilities","version":1,"agentId":"different"}})).await;
        assert_eq!(result["error"]["code"], "MOBILE_TARGET_INVALID");
        let result=o.request(json!({"version":1,"kind":"assets","targetId":"approved","request":{"kind":"capabilities","version":1,"agentId":"agent"}})).await;
        assert_eq!(result["error"]["code"], "OWNED_LOGIN_REQUIRED");
        let result=o.request(json!({"version":1,"kind":"assets","targetId":"approved","request":{"kind":"upload.chunk","version":1,"agentId":"agent","uploadId":uuid::Uuid::new_v4().to_string(),"offset":0,"dataBase64":"AAAA".repeat(8193),"sha256":"a".repeat(64)}})).await;
        assert_eq!(result["error"]["code"], "MOBILE_ASSET_REQUEST_INVALID");
        assert!(o.peer.is_none());
        assert_eq!(ASSET_DEADLINE, Duration::from_secs(8));
    }
    #[test]
    fn retained_channel_policy_and_epoch_changes_fail_closed_and_keep_unsupported_codes() {
        let scope = ConnectionScope {
            service_id: uuid::Uuid::new_v4().to_string(),
            network_id: uuid::Uuid::new_v4().to_string(),
            boot_epoch: uuid::Uuid::new_v4().to_string(),
            connection_epoch: uuid::Uuid::new_v4().to_string(),
        };
        let channel = uuid::Uuid::new_v4().to_string();
        let mut message = serde_json::to_value(&scope).unwrap();
        let fields = message.as_object_mut().unwrap();
        fields.insert("version".into(), json!(1));
        fields.insert("controlId".into(), json!(uuid::Uuid::new_v4().to_string()));
        fields.insert("type".into(), json!("change.available"));
        fields.insert("scope".into(), json!("settings"));
        fields.insert("revision".into(), json!(1));
        assert_eq!(
            control_credit(&message.to_string(), &scope, &channel)
                .unwrap_err()
                .code,
            "MOBILE_POLICY_CHANGED"
        );
        message["connectionEpoch"] = json!(uuid::Uuid::new_v4().to_string());
        assert_eq!(
            control_credit(&message.to_string(), &scope, &channel)
                .unwrap_err()
                .code,
            "CONTROL_SCOPE_MISMATCH"
        );
        let unsupported = json!({"version":1,"controlId":uuid::Uuid::new_v4().to_string(),"type":"error","code":"HOST_MANAGEMENT_EXTENSIONS_UNAVAILABLE","retryable":false});
        assert_eq!(
            control_credit(&unsupported.to_string(), &scope, &channel)
                .unwrap_err()
                .code,
            "HOST_MANAGEMENT_EXTENSIONS_UNAVAILABLE"
        );
    }
    #[test]
    fn owner_cannot_transplant_across_agent_logout_or_expired_epoch_lease() {
        let active = Arc::new(AtomicBool::new(true));
        let selected = target();
        assert!(same_owner(&selected, &target(), &active, &active));
        let mut switched = target();
        switched.agent = "another-agent".into();
        assert!(!same_owner(&selected, &switched, &active, &active));
        assert!(!same_owner(
            &selected,
            &target(),
            &active,
            &Arc::new(AtomicBool::new(true))
        ));
        active.store(false, Ordering::Release);
        assert!(!same_owner(&selected, &target(), &active, &active));
        let now = Instant::now();
        assert!(lease_live(now, now, 110, 100));
        assert!(!lease_live(now, now, 108, 100));
        assert!(!lease_live(now, now - Duration::from_secs(21), 300, 100));
        assert!(!lease_live(now - Duration::from_secs(111), now, 300, 100));
    }
    #[test]
    fn read_frame_limit_accounts_for_original_binary_header_without_widening_payload() {
        assert!(check_frame(&Message::Binary(vec![0; FRAME_BYTES + 22])).is_ok());
        assert!(check_frame(&Message::Binary(vec![0; FRAME_BYTES + 23])).is_err());
        assert!(check_frame(&Message::Text("x".repeat(FRAME_BYTES + 1))).is_err());
        assert_eq!(QUEUE_BYTES, 256 * 1024);
    }
}
