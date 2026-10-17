# Mobile native connection owner

This crate is the native-only account, device identity, directory and outer HTTPS/WSS owner. It reuses the original AgentNet account, PKCE, identity, verifier, transport, policy and admission source by `#[path]`. It has no Node service, Host IPC, systemd, execution owner, global account selection, or credential environment fallback.

The native application installs `NativeConfig { issuer, publicTlsCa? }` and the callbacks in `include/mox_connection.h`. Production normally uses platform public TLS trust (`publicTlsCa: null`); the private device CA comes only from the authenticated descriptor/bootstrap and is used only by the shared SDK's inner TLS channel. No insecure TLS/WS fallback exists. Android must initialize the platform verifier using `mox_connection_android_init` and ship its matching Android verification classes before any request.

The native owner serializes requests on a worker queue. Store callbacks must be thread safe and durably persist before success; the application must exclusively own the store namespace. Original keyed identity gates serialize identical enrollment scopes across native handles within the process. Private keys are saved before issuer activation, compared against existing scoped keys, and read back before success. Account tokens and PKCS8 never cross the JS interface.

Closed version 1 intents:

- `account.status`, `account.login.start`, `account.login.poll`, `account.logout`
- `targets.list`, `operations.pending`, `connection.suspend`
- `session` with an opaque current catalog `targetId` and the exact existing `RemoteSessionRequest`
- `assets` with the same approved target envelope and the separately versioned `RemoteAssetRequest`
- `mobile` with `{version:1,kind:"mobile",targetId,request:<RemoteMobileRequest>}` for negotiated `session.mobile.v1`

Raw C input is first decoded through closed typed DTOs, preserving duplicate and unknown-field rejection before JSON projection. Same-device/agent target IDs remain stable within the native handle across catalog refresh; logout and suspension clear the catalog scope. Metadata-only directory connections close after their snapshot. Healthy retained peers survive routine directory refresh; bounded idle controls are drained first, and policy changes invalidate the peer.

All requests return `{ok:true,value:...}` or `{ok:false,error:{kind:"error",code:UPPERCASE}}`. JS receives only account, login URL, target, pending operation or existing remote-session projections. Target runtime is `null` until obtained from actual Host session metadata. The directory is limited to 100 projected targets and signals truncation with `hasMore`. Unknown pending operations whose target no longer exists remain visible with an empty `targetId`; they cannot authorize a replacement target.

Login obtains a per-login device ID and PKCE verifier, validates the account session, then persists the native account. Device identity and pending enrollment keys use the original full issuer/environment/service/principal/device/generation scope. Joining is an explicit initial mobile enrollment grant persisted as consumed before the original join mutation; ambiguous joins are not retried automatically. The relay permits one outer connection per device and one channel per device pair (`services/agentnet/src/relay_controller.rs`, `relay_recovery_tests.rs`). The native owner therefore retains ONE outer WSS, ONE combined SDK client and ONE TLS channel for the selected device/agent. Session, asset and mobile admission methods multiplex their existing typed request IDs without resetting pair sequences or credits. A target/agent/account switch, policy change, transport failure, trust expiration, 20-second idle period or 110-second hard lease drops the owner. Background suspension drops the mobile connection and never stops the remote Host.

Remote requests validate the account session and exact current device address before dispatch. The crypto-ready announcement is sent using the original ClientMessage::ChannelReady before accepting the relay-ready result. Original signed peer bindings, validated offer direction, SDK inner TLS, flow credits, typed messages and responses remain authoritative. Respond fetches a fresh snapshot and matches the exact generation, turn, request and interaction; positive approval additionally requires actionable state, while explicit denial retains the original owner policy.

Mutations follow SDK prepare → durable native journal → commit. Unknown full records are bounded to 128 per issuer/service/environment/principal and survive key rotation or login device replacement. UNKNOWN/processing/not-found/unconfirmed never triggers automatic resend. Authenticated successful snapshots or accepted/rejected receipts replace the full record with a small confirmed marker and release pending capacity. Confirmed markers retain the operation ID guard; they do not consume the unknown-operation bound. Receipt lookup is read-only. Expired/revoked trust requires fresh authentication, never an offline target.

Asset requests negotiate matching version 1 capabilities before any upload/read/list RPC. Each request contains at most one 24-KiB chunk; the whole asset call, including initial connection and capability negotiation, has an 8-second network deadline. Session and mobile admission calls retain their 35-second deadline. The native serial queue yields between calls, so a file transfer does not hold it for the whole file. Reads accept up to 64 KiB of TLS payload plus the original 22-byte frame header, and use the existing 256-KiB channel credit window. Signed peer/access expirations further shorten the trust lease. No request is automatically replayed after connection loss.

Before each upload effect, a scoped encrypted UNKNOWN marker is persisted. Later effects for that upload are blocked until an explicit authenticated upload.status response resolves the ambiguity. Version 1 ASSET_NOT_FOUND clears only a correlated upload.status marker; an ordinary upload error does not authorize replay. Markers are bounded to 128 unresolved uploads and contain no file bytes, names or paths. Existing session mutations keep their prepare/persist/commit journal, restored for the exact selected agent and target before the retained SDK owner performs its first RPC.

Validation:

```sh
cargo test --manifest-path mobile/connection/Cargo.toml --locked --lib
cargo clippy --manifest-path mobile/connection/Cargo.toml --locked --all-targets -- -D warnings
```

Tests use generated ephemeral keys, bounded loopback HTTP fixtures and a real pinned TLS WebSocket upgrade/DPoP/subprotocol exchange, including rejection of a foreign CA. The sibling SDK tests exercise actual mutually authenticated inner TLS in both relay directions, including asset → session → asset and request-ID multiplexing on the same channel. These tests do not establish a production user login, real mobile Keychain/Keystore behavior, or a real Host session effect; those are separate native/device acceptance gates.

### Stable target identity and encrypted local drafts

Targets additionally expose `identityKey`, the lowercase SHA-256 of a canonical
JSON tuple `(issuer, serviceId, environment, networkId, principalId, targetDeviceId,
agentId)`. It survives display-name changes, catalog ID regeneration and native
suspension. It is a cache key; only a current native-approved `targetId` authorizes
requests. Neither draft requests nor execution requests accept caller-supplied
identity/account/device/path bindings.

Closed local intents are `draft.read` (`version:1`, `targetId`, required nullable
`sessionId`) and `draft.write` (the same plus `expectedRevision`, `writeId`, `text`).
Replies are `{kind:"draft",identityKey,agentId,sessionId,text,revision,lastWriteId}`.
An absent draft returns empty text, revision 0, and null lastWriteId. To clear text,
write an empty string with the current revision and a fresh canonical UUID.
There is no deletion/eviction intent. Each account retains at most 64 reservations,
including empty drafts and interrupted first writes. Session IDs are null or 1–99 ASCII letters, digits and hyphens, matching the
original session contract; persisted index and record bindings enforce the same rule. Text is limited to 16,000 UTF-16 units; raw request JSON,
persisted index and each record are limited to 64 KiB. Revisions are safe u53.

Drafts use the same native OS encrypted record callbacks, under a separate hashed
account namespace and a record hash bound to the complete target/session tuple.
The encrypted index is reserved and read back before the record is written;
record bytes and the completed index are read back before success is acknowledged.
Missing confirmed records, orphan records, foreign bindings and malformed state
fail closed. A process-local synchronous gate serializes index reservation/CAS
across handles; native callers must retain their serialized owner queue and must
not invoke reentrant callbacks. There is no cross-process file lock contract.
Stale revisions return `MOBILE_DRAFT_CONFLICT`. The current lastWriteId with the
same text returns the saved revision; a different payload is rejected. An
unconfirmed write may have persisted, so callers retry the same writeId/text or
read current state rather than inventing success.

Draft operations perform no HTTP and do not restore login from disk. A cold owner
must first complete the ordinary verified account and target restoration. A warm
loaded account can use drafts without network availability, while its session is
valid and its target remains in the current approved catalog. Suspend clears that
catalog; logout, expiry or an inactive owner prevents writes into the old scope.
Session and asset operation journal formats are unchanged. Callback/restart tests prove
native adapter behavior with synthetic storage; actual device encryption and
restart acceptance remain the integrating owner's checks.


### Negotiated mobile admission

The `mobile` wrapper accepts only the closed version 1 `RemoteMobileRequest`
namespace. Protocol JSON is limited to 48 KiB; the raw outer intent is limited to
64 KiB. Raw duplicate/unknown fields are rejected before Value normalization.
The native owner sends and verifies `mobile.capabilities` before other mobile
RPCs, then reuses the same combined TLS/credit/pair-sequence owner for
capabilities, models, suggestions, start, send and receipt. Unsupported capability
errors are returned honestly, without dispatching the requested effect or falling
back to legacy execution. Typed SDK responses fence request ID, method, Agent,
session and suggestions revision. The reply is the exact `RemoteMobileResult`.

Mobile mutations use `PrepareMobile` → native persistence/readback → `Commit`.
Legacy and mobile records share the original 128-operation encrypted ledger;
legacy record JSON, digests and confirmed-marker bytes retain their original
format. Native recovery decodes the SDK's untagged `JournalRequest` union and
restores matching Agent/device/trust records before the owner's first RPC,
including capability negotiation. Neither timeout nor recovery automatically
resends an unknown operation. The complete mobile RPC has the same 35-second
session deadline; timeout reports `MOBILE_SESSION_UNKNOWN`, invalidates the
owner and preserves unknown records.

`operations.pending` returns
`{kind:"operations",items:[{protocol:"session"|"mobile",targetId,agentId,operationId,sessionId,status:"unknown"}]}`.
Only the new `protocol` item field is additive; callers must use the matching
receipt method. A receipt for the other protocol cannot settle an operation with
the same UUID. Authenticated mobile Accepted/Rejected receipts additionally match
the original persisted send's session ID. Processing/NotFound/Unconfirmed and
errors retain the full unknown record. Journal reservations, full records,
confirmed markers and pending-list updates require exact native readback.

Native connection regressions cover both ledger variants, frozen legacy JSON,
scoped recovery, cross-protocol settlement, original-session matching, UNKNOWN
retention, native callback persistence failure and raw input limits. Independently
rerun core tests exercise actual mTLS interleaving and authenticated mobile reply
fences. These do not claim an actual mobile device or live Host acceptance.
