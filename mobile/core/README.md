# MoXBots native controller core

This is a portable Rust library (`staticlib`, `cdylib`, `rlib`), not a second Agent
runtime. It imports the existing desktop `channel.rs` and `jwt.rs` by path and
uses the shared crypto/protocol crates. `session.remote` remains the existing
closed v1 protocol. No private keys, raw HTTP, provider settings, filesystem paths
or arbitrary management methods are exposed to JavaScript.

## Native boundary

The native owner serializes all calls on one queue and supplies:

- Platform HTTPS trust, configured issuer/account selection, DPoP account HTTP,
  authenticated WSS/relay and fresh relay-issued connection epochs.
- OS encrypted credential storage. PKCS8 is passed separately to `mox_mobile_new`
  and immediately wrapped in `Zeroizing`; erase the caller's input after use.
- Durable encrypted operation records. Persist the exact `prepare` record before
  `commit`; storage failure must prevent commit. Never auto-commit a recovered
  record, including after `not-found`, `unconfirmed` or a transport timeout.

`include/mox_mobile.h` defines the ABI. Rust callers can use `MobileClient::new`,
`execute(Intent)`, `feed_frame`, and `drain_frame`. Native authenticated relay
controls call `relay_credit(sequence, received_bytes)` and, after successful feed,
`take_received_credit()` to send cumulative byte acknowledgments. The corresponding
C ABI calls are `mox_mobile_credit` and `mox_mobile_received_credit`. Drain pauses
at the original protocol channel/socket queue windows; duplicate, skipped,
non-increasing or excessive grants fail closed. Buffers have explicit status
(0 success, 1 JSON error); free them once using `mox_mobile_buffer_free`. Do not
expose constructor, feed/drain, commit/recover or raw storage APIs to JS. The native
bridge projects only approved UI intents/results and handles journaling itself.

Native-only constructor JSON (camelCase):

```
issuer, local, target, channelId, localEpoch, targetEpoch,
jwks, bootstrap, localSignedPeer, targetSignedPeer, certificate, trustExpiresAt, tlsInitiator
```

`tlsInitiator` must match the validated relay Offer initiator (device ordering),
independent of the management Controller role; both TLS directions are supported.

`local`/`target` are exact protocol `DeviceScope` objects:
`serviceId`, `environment`, `networkId`, `principalId`, `deviceId`, `keyGeneration`.
`jwks` must come from the configured issuer through native verified HTTPS, never
JS or a token-selected URL. `bootstrap` and both signed peers are verified using
the original JOSE verifier. The bootstrap binds account, service, local device,
key generation, DPoP thumbprint, relay origin and CA. `certificate` is the single
local leaf PEM, matched to its signed fingerprint and supplied key. TLS verifies
the remote signed fingerprint/SAN and the encrypted ChannelHello verifies exact
network/account/device/key-generation/connection-epoch scope.

`trustExpiresAt` must be current and at most 300 seconds in the future. The handle
expires at the earliest trust/bootstrap/local-binding/target-binding deadline.
On suspend or a feed validation failure it is permanently invalid. Recovery must
obtain fresh native authorization and a new relay connection epoch, construct a
new handle and restore scoped journal records before issuing effects. Reusing an
old connection epoch with reset pair sequences is forbidden. Native owns this
lifecycle and cannot reconstruct a handle from cached JS state.

## Requests, uncertainty and output

- `{kind:"prepare",request:<RemoteSessionRequest>}` accepts only mutations and
  returns `{state:"journal-required",record:{operationId,digest,request,target,issuer}}`.
  The digest covers issuer, complete target and canonical typed request.
- Native durably persists that record, then calls
  `{kind:"commit",operationId,digest}` once. The returned `submitted` state means
  encrypted bytes were queued, never that a Host operation completed.
- `{kind:"request",request:...}` accepts only capabilities/list/get/receipt.
- `{kind:"recover",records:[...]}` atomically restores at most 128 unknown records
  before use. Cross-target, cross-issuer and duplicate/conflicting records fail.
  ABI JSON is bounded to 64 KiB; native must keep a recoverable bounded journal.
- Query original operation receipts after uncertainty. An unknown operation cannot
  be committed again on this handle; even `not-found` does not grant resend.
- `relay-ready` is supplied by the authenticated relay, after encrypted hello.
  TLS/management readiness and relay readiness are separate original channel gates.
- `feed` accepts complete AgentNet binary TLS frames and returns authenticated,
  correlated `{kind:"response",requestId,data}` or `{kind:"error",requestId,code}`
  events plus status. Unsolicited, wrong-method or wrong-scope responses fail closed.
- `suspend` invalidates authority; `status` returns readiness and unknown UUIDs.

A handle bounds its active journal to 128 operations and in-flight requests to 64.
Authenticated matching Accepted/Rejected receipts release full bodies from the
active journal and retain UUID replay tombstones (up to 4096 per authorization
epoch). Unknown/Processing/NotFound/Unconfirmed records are never evicted. The
native encrypted store must persist confirmed tombstones before pruning full
bodies, and keep unknown full records for recovery; daily confirmed operations do
not consume the 128 unknown-record budget. There is no automatic replay,
expiry-based removal or success synthesis. Native retains its durable records
independently and reconciles them on fresh authorization.
The current core has no account login UI, outer HTTP/WSS event loop, notification
provider or microphone/ASR implementation; these belong to
the mobile native/Host integration owners.

## Verification

Use the root pinned Rust 1.92.0 toolchain:

```
cargo test --manifest-path mobile/core/Cargo.toml --locked
cargo clippy --manifest-path mobile/core/Cargo.toml --locked --all-targets -- -D warnings
cargo build --manifest-path mobile/core/Cargo.toml --locked --release
```

Tests include original channel/JOSE tests, actual TLS controller-to-existing-Host
interoperability, signed native provisioning, account/target/key mismatches,
immutable operation UUID/digest, recovered uncertainty and ABI allowlist limits.
Host tests do not establish iPhone/Android native acceptance. Cross-builds require
Apple's iOS SDK or Android NDK and target-specific linkers; inspect the task record
for actual outcomes instead of inferring them from the crate types or installed
Rust targets.

## Native profiles and one relay owner

Native config accepts exactly `profile:"session"` (default), `"assets"`, or
`"combined"`. Session-only and assets-only restrictions remain unchanged. The
Combined profile exposes only the existing `session.remote` and owned
`session.assets.v1` / `session.mobile.v1` typed methods; it is not an arbitrary management-method port.
Choose the profile in trusted native provisioning, never from a JavaScript intent.

The actual relay allows one outer WSS per device and one channel per device pair.
An additional socket would replace the device connection, and a second channel for
that pair is rejected with `CHANNEL_PAIR_EXISTS`. Therefore the native connection
owner must create one Combined MobileClient for the authenticated device pair and
outer connection epoch, retaining its original Channel, PairSequences, pending
request table and cumulative relay credit across asset/session/asset operations.
Do not recreate a handle or reset pair/management sequences between methods. A new
handle still requires a fresh authenticated outer epoch under the existing recovery
contract. The SDK does not create an extra socket, identity, or cloud protocol.

In Combined mode the first valid session Prepare/Request, initial asset capabilities
request, or atomically recovered journal binds the owner to one Agent. Subsequent
session requests, asset requests and every recovered record must match that Agent;
otherwise the request is rejected without emitting bytes. Mixed-agent recovery
fails atomically without altering the active journal or binding. The existing
Recover-before-first-RPC rule remains: restore only this Agent's unknown records
before even sending asset capabilities. Commit uses the immutable matching journal;
recovered effects still require receipt queries and cannot be automatically resent.
Changing the selected Agent requires the native owner to end/recover its lifecycle,
not to replace only the SDK while keeping the old outer epoch.

`{kind:"asset-request",request:<RemoteAssetRequest>}` is native-only. Asset data
still requires an authenticated matching capabilities response first; session
operations never grant that capability. Assets-only mode cannot execute a session
intent; Session-only mode cannot send assets. Responses retain `asset-response` or
`response` events and exact requestId/method/Agent/upload/artifact/session/offset
correlation even when the peer returns mixed outstanding requests out of order.
All methods share the existing bounded 64-request pending table and relay windows.
Native should keep sequential chunk scheduling bounded so user control work can
progress on this same encrypted stream.

Chunks remain canonical base64 for at most 24 KiB. Request IDs and queued chunks
never imply full file or turn completion. Explicit upload.status and matching
byte offsets/hash govern resumption; session v1 wire shapes and execution journal
semantics are unchanged. Combined tests use actual TLS against the existing Host
channel implementation and its strict sequence validation; actual outer relay and
native platform integration remain separate parent-owned acceptance gates.

## Opt-in mobile session admission

Combined additionally permits the closed owned `session.mobile.v1` projection.
Native must first request `mobile.capabilities` and receive the exact authenticated
capabilities result for the bound Agent. Assets capabilities and legacy session
capabilities do not grant mobile admission. The same original Channel, pair
sequences, outer epoch, pending map and flow credit continue across all three
methods. There is no arbitrary method or provider-credential port.

Native uses `mobile-request` for capabilities, models, suggestions and receipts;
`prepare-mobile` accepts only mobile.start/mobile.send. Persist the returned opaque
record durably before `commit`, exactly as with legacy Prepare. The digest covers
the original text, ordered assetIds, optional modelId, operation UUID and existing
authenticated scope. A UUID cannot change parameters or protocols. A record's
stored protocol selects the Commit method; JavaScript does not choose it.

JournalRequest is an untagged Legacy/Mobile enum: legacy record JSON and digests
remain byte compatible, while `mobile.` request kinds disambiguate new records.
Restore all of this Agent's mixed-protocol unknown records before any RPC; restore
is atomic. Recovered effects are receipt-only and cannot be recommitted, even after
not-found. Accepted/rejected receipts only clear journals of the same protocol;
confirmed UUID tombstones block both protocols. A mobile.send receipt, including a
query after recovery, must contain the original sessionId. Native must retain the
opaque protocol and durable confirmed marker as well as the UUID.

Events use `mobile-response` plus exact requestId and typed data. Suggestions bind
Agent/session/revision; receipts bind Agent/operation and a send's original session.
The authoritative management JSON Schema describes the closed structural forms.
Rust/Zod codecs additionally enforce UTF-16 and serialized UTF-8 budgets,
per-field Unicode rules and arithmetic/cross-field invariants noted in the schema.

This package implements the type, crypto and journal boundary only. Real Host
mobile admission, model catalog/allowlist, trusted attachment leases, permission
rechecks and SessionEngine side effects remain integration gates. TLS fixture
receipt responses establish protocol behavior, not actual Host support or a real
model execution outcome. Existing session.remote v1 DTOs remain unchanged.
