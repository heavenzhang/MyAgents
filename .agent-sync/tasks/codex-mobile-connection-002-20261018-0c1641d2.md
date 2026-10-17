<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/mobile-connection-002-20261018 -->
<!-- git-project-sync-task:base=54456225412e892a6ad15704cdf6dc4acffce8e1 -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-MOBILE-002 — Native account and relay connection owner

## Objective and scope

Implement only `mobile/connection/**`: actual owned account PKCE/session validation, account-scoped device identity and enrollment, HTTPS directory, verified WSS control connection and shared mobile SDK session transport. Parent owns native OS storage, UI, Host extensions, integration/main and releases. No real credentials, account mutations, production deployment or external dispatch occurred in this worker.

## Acceptance criteria

- [x] Read project map/plan, vendored sync skill, task record and source; parent-confirmed start/task-init gates PASS for explicit repository https://github.com/heavenzhang/MoXBots.git.
- [x] Original account/login/identity/JWT/transport/policy/admission modules reused without policy fork; unavailable official account adapter cannot capture desktop credentials.
- [x] Native C ABI and bounded generic encrypted-store callbacks; key conflict/readback protection; closed JS intent and safe reply projections.
- [x] Real HTTPS PKCE + validated session + persisted account, per-account/device identity, consumed enrollment grant, original hello/catalog/policy/ready handshake and same-account directory.
- [x] SDK inner TLS/controller with validated relay direction, native durable prepare/commit, bounded UNKNOWN journal and confirmed markers, fresh approval snapshot and scoped receipt lookup.
- [x] Foreground connection suspension preserves remote Host execution; unknown operations never automatically resent.
- [x] Original parity and native owner tests, credential-free loopback HTTP, actual pinned TLS WSS upgrade and foreign-CA rejection.
- [x] Raw C JSON validates original typed DTOs before normalization, preserving duplicate/unknown-field rejection; same-device/agent opaque catalog IDs survive refresh, removed targets are revoked, and metadata-only directory snapshots close their unpumped idle WSS epoch.
- [ ] Parent independent integration review, iOS/Android target build and true native OS store acceptance.
- [ ] Authorized real account/device/Host session acceptance; not proven by synthetic tests.
- [ ] Parent remote main integration/push and release, outside this worker's authority.

## Completed

Native account/session stage delivered in 9213d172 + 2cbb86a1 and pushed by parent. This stage adds versioned assets through ONE retained combined channel; parent owns native pickers, file IO, Host dispatch, UI and production. Parent revised the separate-transport proposal after source inspection proved one outer/device and one channel/pair. Existing session DTOs remain unchanged.

- [x] One retained combined outer/TLS/SDK owner, asset capabilities negotiation, exact account/target/agent/epoch fence; routine directory refresh preserves a healthy owner.
- [x] Whole asset RPC bounded to 8 seconds, one 24-KiB chunk, 64-KiB TLS payload/256-KiB credit bound, explicit status recovery after ambiguous upload effects.
- [x] Suspend/logout/policy/transport invalidation, closed raw asset intents and regression verification; original crypto-ready relay announcement restored.

## Dependencies

Parent shared crypto native-store feature commit c795947a (local cherry-pick eeb9d704). SDK commits f7d36a40, 043bcfc1, d9c48fa1, a120276d were cherry-picked locally only to compile and validate; parent should integrate those from the SDK worker and cherry-pick only this worker's own connection commit. Link only the connection static archive; it includes its core dependency. Header: `mobile/connection/include/mox_connection.h`. Asset dependencies: bdae87ac, 93f03803, d8899836 and b13b4ae0 were cherry-picked as approved shared dependencies; do not duplicate their changes when integrating this worker's final commit.

## Verification

`cargo test --manifest-path mobile/connection/Cargo.toml --locked --lib`: 72 passed. `cargo clippy --manifest-path mobile/connection/Cargo.toml --locked --all-targets -- -D warnings`: passed. Shared core locked tests independently rerun: 32 passed, including real encrypted interleaving. Cargo.lock contains only rustls-platform-verifier 0.6.2 and Android verifier artifact 0.1.1. C header ABI is unchanged. README records source ownership, callback contracts, limits and real-device gates. No package installation, real user login/enrollment, model call, live Host effect, main merge, push or deployment was performed. Requested versus runtime-confirmed model/time/token usage remains unknown.

## Blockers and unknowns

Actual device/Host acceptance remains parent-owned. Resume gate PASS at parent-pushed eeb6691b after correcting the earlier task record headings/status. Full native owned-account → actual relay → actual Host file transfer is not proven by the synthetic HTTP/WSS and SDK TLS tests. The earlier native session implementation omitted the required crypto-ready channel announcement; this stage corrects it, and the old source must not be packaged as a validated mobile connection. Xcode license was not accepted by this worker; per-command CLT selection was used without changing global configuration.

## Next step

Parent cherry-picks only the final owned connection commit after the accepted combined SDK dependencies, rebuilds the actual Android/iOS native library, integrates bounded native file IO, and completes authorized real account/Host acceptance.

## Stable target identity and encrypted draft stage

Resumed the exact clean parent-pushed 105865f6 branch; explicit-remote resume gate
PASS. No SDK dependencies, app/NativeModule files, session/asset journal formats
or production state changed in this bounded stage.

- [x] Add stable opaque target identityKey from canonical issuer/service/environment/network/principal/target-device/agent tuple; targetId remains current native catalog authorization.
- [x] Closed draft.read/draft.write with required nullable sessionId, u53 revisions, UUID writeId, 16,000 UTF-16 text and 64-KiB JSON bounds. Empty read is text empty, revision 0, lastWriteId null; clear uses write empty text.
- [x] Native approved-target and validated in-memory account scope only; local operations never restore/discover/call HTTP. Invalid/expired/inactive account and removed catalog IDs fail closed.
- [x] Separate OS-encrypted account index reserves up to 64 records before writing; complete target/session binding is validated on read. Exact readback confirms index/record persistence. Missing confirmed and orphan/foreign records are rejected rather than overwritten.
- [x] Revision conflicts, current-writeId idempotency, changed-payload rejection, process-local serialized CAS/index gate and bounded quota; records including empty drafts are retained without eviction.
- [x] Synthetic native C callbacks cover restart reads, account/target/session isolation, stale revision and exact retry, unconfirmed writes, corruption rejection, UTF-16 and capacity boundaries, raw strict duplicate/unknown/missing-field parsing.
- [ ] Parent review/app integration, actual iOS/Android OS-store acceptance, real account/Host acceptance, main/release delivery remain parent-owned and are not claimed here.

Verification: connection locked lib suite 80 tests; all-targets clippy with
-D warnings. No real credentials/device storage/Host operations used. Parent
should cherry-pick only this stage's connection-owned commit and rebuild native
archives before testing app draft restoration. Requested/runtime-confirmed model
and token cost remain unknown.

### Draft session ID review correction

Parent review required alignment with the original session identifier contract:
null or 1–99 ASCII letters/digits/hyphens. Both local intents and persisted
index/record validation now enforce it. This replaces the earlier allowance for
an empty session string; empty text remains the clear-draft operation. Regression
covers empty, 100-character, slash, control, non-ASCII and oversized identifiers,
99-character acceptance and invalid stored bindings. Locked connection lib suite:
81 passed; all-targets clippy -D warnings passed. No peer/SDK change in this fix;
new session.mobile.v1 integration awaits the parent's SDK dependency commit.

## Negotiated session.mobile.v1 connection stage

Parent directed a normal merge from authoritative integration 1618ca0e. Shared
SDK/protocol add/add conflicts were reported before editing; parent explicitly
authorized resolving the exact dependency paths from that root revision. Merge
f61a8fd9 records this dependency integration. Parent should cherry-pick only the
subsequent connection implementation commit, not this dependency merge.

- [x] Closed version 1 mobile wrapper with RemoteMobileRequest, 48-KiB typed protocol/64-KiB raw intent limits and raw duplicate/unknown field rejection.
- [x] Explicit mobile.capabilities negotiation on the same retained Combined owner; exact current catalog Agent, account, epoch and response scope fences remain enforced by native and SDK.
- [x] PrepareMobile → durable native index/full-record write and exact readback → Commit, sharing the original 128 UNKNOWN ledger. Legacy JSON/digests/marker bytes and limits stay compatible.
- [x] Restore JournalRequest legacy/mobile union before the owner's first RPC; scoped matching target/Agent records only, with no automatic execution resend. Original pending projection adds protocol:'session'|'mobile' per item; parent owns app receipt-method consumption.
- [x] Mobile and legacy settlement verify stored protocol/target/Agent; cross-protocol same-UUID receipts cannot settle one another. Mobile receipt queries match the original immutable send session. UNKNOWN/Processing/NotFound/Unconfirmed/error retain records; 35-second timeout invalidates owner and reports MOBILE_SESSION_UNKNOWN.
- [x] Connection locked lib suite 86 passed; independently rerun shared core locked lib suite 39 passed, including real encrypted mTLS mobile/legacy paths, frozen legacy journal, protocol and session/revision response fences. Connection all-targets clippy -D warnings passed. git diff --check passed.
- [ ] Parent integration review/native app rebuild and actual authorized device/account/Host acceptance remain unproven. No real credentials, model calls, production writes, main merge or release performed by this worker.

Next step: parent cherry-picks only the new connection-owned commit onto its
already integrated 1618ca0e dependencies, consumes pending.protocol in the app,
rebuilds the native archive and completes real-device/Host verification. Model
runtime identity, token usage and monetary cost remain unavailable.
