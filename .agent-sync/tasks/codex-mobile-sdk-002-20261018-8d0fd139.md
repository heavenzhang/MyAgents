<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/mobile-sdk-002-20261018 -->
<!-- git-project-sync-task:base=5f9df60445fdb3b5a4271c28eeecbbcc7f6fa1f0 -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-MOBILE-002 — portable encrypted controller core

## Objective and ownership

Current SDK worker owns `mobile/core/**`, `mobile/asset-store/**`, owned management
asset/mobile DTOs, authoritative management schema and shared TS parity files, plus
this task record. Parent owns native bridges, login/transport integration, Host
admission, final main integration and release. Feature-branch commits and normal
pushes are explicitly authorized; no main merge or production operations here. Shared native
crypto key adapter from parent c795947a is locally cherry-picked as 3e0c6f9c.

## Acceptance criteria / To Do

- [x] Independent Rust 1.92 core produces staticlib/cdylib/rlib; no desktop OS store.
- [x] Reuse exact shared crypto, JOSE verifier and encrypted Channel implementation.
- [x] Scoped native provisioning, exact v1 remote-session types and strict ABI allowlist.
- [x] Prepare/durable-native-journal/commit boundary and UNKNOWN receipt-only recovery.
- [x] Actual encrypted controller-to-existing-Host-channel interoperability tests.
- [x] Wrong account/issuer/service/device/key generation, target/replay and closed intent tests.
- [x] Final focused ABI tests, clippy -D warnings and macOS host release build.
- [ ] Latest mobile-method Android cross-build/link and real device tests (parent);
  parent reports earlier core/connection Android releases passed after NDK installation.
- [ ] iOS cross-build/link and real device tests; Apple iOS SDK not currently available.
- [ ] Integrated native login/WSS/SessionEngine/notification/file/voice acceptance (parent).
- [ ] Main / remote delivery and production release (parent; outside worker authority).

## Completed

`mobile/core/include/mox_mobile.h` is the native ABI contract; buffers include status,
length and owned data. `src/agent_network.rs` adapts a native pinned trust snapshot to
the original JWT verifier and imports original channel by path. `src/lib.rs` verifies
bootstrap/DPoP/local and target binding/certificates, enforces immutable scoped journal
records, and matches authenticated responses to exact request scope/method. `src/ffi.rs`
provides bounded native-only ABI, sanitized errors and owned-buffer disposal.

Native must prove secure durable writes before commit and supply authenticated issuer
trust; constructor/commit/feed/recover are never JavaScript APIs. Every new handle
requires a fresh authenticated relay connection epoch. Trust expires within 300 seconds
and at earlier credential deadlines; suspend/invalid feed permanently ends handle.
No HTTP/WSS/login/attachment/ASR/notification implementation is claimed by this crate.
No fake completion, automatic resend, or protocol changes to existing v1.

## Verification

- `cargo test --manifest-path mobile/core/Cargo.toml --locked --no-fail-fast`: 22 passed
  before final extra ABI/scope checks (latest final run will follow).
- Tests use synthetic keys and real TLS between the SDK and existing Host channel,
  plus original replay/nonce/role/hello/JOSE regression suite. No external services.
- Final focused run after relay-credit follow-up: 27 tests passed; clippy all-targets
  with -D warnings passed. final macOS host release build passed, including all crate types.
- `cargo check --manifest-path mobile/core/Cargo.toml --locked --target aarch64-apple-ios`:
  failed at ring C build because `xcrun` cannot locate `iphoneos` SDK. This is a real
  environment failure, not successful native portability validation.
- Initial clippy diagnosed shared original channel constructor arity; import preserves
  original signatures using same targeted allowance as headless-network.

## Blockers and unknowns

Parent integrates feature-branch commits and owns actual native/Host acceptance.
Earlier license/SDK/push statements below are historical checkpoints. Android NDK
is installed and parent reported earlier core/connection Android release builds
passed. The latest mobile-method delta still needs parent platform verification.
Apple Xcode license acceptance remains pending user action; this worker uses only
previously accepted CommandLineTools and does not accept that license.
Actual Host mobile admission/model allowlist/file leases/SessionEngine integration,
real accounts/devices and production acceptance are not established by core fixtures.

## Relay flow-control follow-up

Connection integration identified the outer cumulative credit policy, separate from
TLS channel sequence enforcement. Core now exposes native-only `relay_credit` and
`take_received_credit` (and C equivalents), validates original strict credit sequence
and cumulative byte constraints, and withholds drain at protocol channel/socket
windows. Duplicate/oversized grants close the handle. Actual feed bytes are credited
only after successful validation. Focused window/duplicate/release tests passed.

## Final worker acceptance

- 27/27 Rust tests passed; clippy `--all-targets -- -D warnings` passed; release build passed.
- Release dylib loaded through actual C ABI using ctypes: 8 exports present, 24-byte
  buffer layout, sanitized constructor failure and owned-buffer free passed.
- Native config `tlsInitiator` must reflect the validated Offer initiator, independent
  of Controller management role. Dedicated deterministic responder TLS test passed.
- iOS actual cross-check failed solely at missing `iphoneos` SDK; Android NDK license
  authorization remains with parent. Neither platform native SDK acceptance is claimed.
- No remote push, main integration or production release performed by worker.

## Confirmed receipt and capacity boundary

Authenticated matching Accepted/Rejected receipts clear operation bodies from the
active 128-record journal and retain bounded UUID tombstones (4096 per auth epoch).
The UI unknown list now reflects actual uncertain operations. Tombstones continue
to block resend of a confirmed UUID; NotFound/Unconfirmed/Processing never grant
replay or remove unknown records. Actual encrypted NotFound→explicit receipt query→
Accepted test and full 128-record capacity recovery test passed. Connection owner
confirmed persistent native markers survive key rotation/new handles and prune only
confirmed full bodies; unknown full records remain on disk. Final 27 tests, clippy
and host release passed after this change.

## Next step

Deliver the closed mobile-method package to parent for integration. Parent owns
remote publication needed by the resume gate; worker does not push or merge.
New ownership: mobile/core, mobile/asset-store, remote_assets.rs plus necessary
management codec additions, shared remoteAssets.ts and parity fixtures/tests.
Original session.remote v1 and outer vendored public protocol remain unchanged.
Pure store receives authenticated native scope; parent wires actual Host/runtime.
Android NDK is now authorized and installing/being validated by parent; historical
license blocker above is resolved. iOS SDK/system-admin setup remains parent-owned.

## Asset extension — contract and encrypted controller

- Resume gate passed against remote bdae87ac and verified canonical URL/base.
- Added closed owned method session.assets.v1, versioned bounded request/result
  types and Rust/Zod shared valid/invalid fixtures. Public vendored network and
  original remote_session.rs / remoteSession.ts remain unchanged.
- Assets uses a separate native profile/channel, authenticated capabilities
  before data, one Agent binding and typed request/result correlation. File bytes
  and labels are redacted from new protocol Debug projections.
- Core 29 tests passed, including encrypted 24KiB asset RPC and foreign-agent
  response closure. Management codec 26 tests passed; focused new+legacy Vitest
  fixtures passed with existing Zod 4.1.12 dependencies. No Host path claimed.
- Store implementation/tests are staged separately next; native integration is
  still parent-owned. Android native rebuild with this extension is not yet run.

## Asset extension — native scoped storage

- Added standalone mobile/asset-store with capability-relative no-follow I/O and
  process-shared filesystem reservation lock. Native AssetScope is never RPC input.
- Real durable sequential chunks, exact duplicates, restart hash validation and
  unacknowledged-tail truncation; finish validates exact size and full SHA256.
- Scoped 8-active/160MiB and global 1GiB bounds, bounded metadata counts, explicit
  TTL/cancel cleanup, cancelled-crash retained-byte accounting, ready leases, and
  trusted output-owner artifact copying/list/read. No executor or transcript scan.
- Ten real TempDir tests passed and clippy all-targets -D warnings passed.
- Remaining platform gates: Linux/Windows native filesystem acceptance, actual Host
  dispatcher/session admission, UI/native upload and preview, and Android/iOS fresh
  extension builds. Worker does not claim these from pure store or TLS fixtures.
- Parent must keep output registration rooted in the real transcript owner and
  retain ready leases through SessionEngine attachment admission/consumption.

## Asset extension — final parity check

Final required-nextBefore-nullability fixture fixed a Rust Option default that
would accept an omitted field rejected by Zod. New+legacy Vitest fixtures passed;
management codec 26, core 29 and asset store 10 tests all passed on final sources.
Protocol/core/store strict clippy passed. Final Rust linking explicitly selected
previously installed CommandLineTools for macOS because the newly active Xcode
SDK license prompt blocks default tools; no unlicensed Xcode/iOS SDK was used.
Parent retains the system license flow and actual Android/iOS/Host integration.

## Combined owner — actual relay constraint correction

The actual relay replaces an existing WSS for the same device (relay_controller.rs
hello connection ownership) and rejects a second same-pair channel with
CHANNEL_PAIR_EXISTS (relay_recovery_tests.rs actual_same_pair_open_race...). This
supersedes the earlier separate-channel asset proposal; no cloud behavior changes.

- [x] Resume gate passed against d8899836 after authorized SDK feature-branch push.
- [x] Native-only profile combined permits exactly the original two closed methods;
  default Session and explicit Assets restrictions remain intact.
- [x] One MobileClient/Channel/PairSequences/pending map/credit lifecycle is retained
  across mixed methods; no second socket or identity is created by SDK changes.
- [x] Core binds a single Agent on first valid session/asset/recovered record;
  mixed/foreign recovery is atomic and fails without journal/binding mutation.
- [x] Actual TLS tests cover capabilities→upload→session read→journalled mutation→
  asset continuation, reversed mixed responses, continuous original peer sequence
  acceptance, cross-Agent/profile rejection, and receipt-only recovered effects.
- [x] Core 32 tests, all-targets clippy -D warnings and release build passed on
  existing CLT macOS tools. No iOS SDK license acceptance or build was attempted.
- [ ] Parent native connection/actual relay single-owner integration and native
  platform acceptance remain outside this worker's claim.

Connection owner was informed: choose profile combined at construction, restore
only that Agent's unknown journal BEFORE any RPC/capabilities, then keep the same
SDK and outer connection epoch throughout. No public DTO or v1 wire edits.


## Mobile session admission method — current package

- [x] Resume gate passed at published b13b4ae0 before editing; original base and
  remote remain unchanged. No new task, socket, identity or executor was created.
- [x] Closed owned session.mobile.v1 DTOs and shared Rust/Zod fixtures cover all
  requested capabilities/models/suggestions/start/send/receipt/result kinds,
  mandatory nullable fields, unique bounded assets, opaque model labels and
  48KiB serialized control bound. Legacy session.remote source DTOs are unchanged.
- [x] Combined-only explicit mobile capabilities gate and the existing same-Agent
  owner bind apply before mobile requests. All methods retain one original Channel,
  PairSequences, pending table, outer epoch and relay flow-control lifecycle.
- [x] PrepareMobile persists an opaque untagged Legacy/Mobile JournalRequest;
  Commit dispatches from stored protocol. Digest includes text/assets/model/scope.
  Frozen legacy serialized record and digest roundtrip exactly. Unknown recovery
  remains atomic/query-only, cross-protocol receipts never confirm each other,
  and confirmed UUID tombstones block either protocol.
- [x] Exact pending method/requestId/Agent/session/revision/operation correlation;
  mobile.send receipts queried after recovery also require the original sessionId.
  Mismatch closes authorization without clearing unknown. Host should return the
  typed mobile.error when no matching session can be reported.
- [x] Authoritative host-management-v1.schema.json now admits only the closed assets
  and mobile methods/params/results. Rust JSON Schema validator tests use the same
  fixtures, reject unknown DTO/wrapper fields and wrong method/param pairs.
  Schema comments explicitly retain executable codec enforcement for UTF-16/UTF-8
  budgets, unique model IDs and arithmetic relationships absent in standard schema.
- [x] Existing-channel TLS test writes/fsyncs/reads a real temporary durable record
  before commit, then validates mobile receipt and continuing v1 snapshot. Additional
  tests cover raw text/asset/model changes, cross-protocol UUID reuse and receipts,
  mixed-Agent restore, profile bypass and wrong suggestion revision/send session.
- [ ] Parent Host admission/model allowlist/asset leases/actual SessionEngine writes,
  native connection mobile intent adoption, platform builds and real-device tests.

Verification commands use DEVELOPER_DIR=/Library/Developer/CommandLineTools.
Final exact counts/build outcome follow in the handoff report; no native/Host
support or model execution completion is inferred from TLS fixture responses.
Requested worker model/effort remains gpt-6.1-sol/medium for consequential cross-layer
side-effect isolation. Runtime model/tokens/cost are not independently observable.

Final package verification (2026-10-18, existing CLT macOS tools):
- cargo test --offline --locked --manifest-path mobile/core/Cargo.toml: 39 passed.
- cargo test --offline --locked --manifest-path src-tauri/host-management-protocol/Cargo.toml:
  28 passed (7 unit, 6 codec, 9 extensions, 1 authoritative schema, 5 legacy sessions).
- Both crates: cargo clippy --offline --locked --all-targets -- -D warnings passed.
- cargo build --offline --locked --manifest-path mobile/core/Cargo.toml --release: passed.
- Existing Vitest unit runner: remoteMobile/remoteAssets/remoteSession parity, 3/3 passed;
  reused the parent-authorized ignored node_modules symlink, no npm installation.
- Added only test dependencies tempfile and the same pinned jsonschema 0.58.3 already
  used by the shared network protocol; no new production dependency or crypto fork.
- Initial aggregate-size fixture was corrected to exceed 48KiB after including the
  actual UTF-8 model/assets overhead; both Rust and TS reject the corrected fixture.
- Initial schema wrapper-smuggling check found permissive untagged struct variants;
  deny_unknown_fields closes the new assets/mobile wrappers. All original tuple DTO
  regression tests still pass; no legacy session DTO source changes were made.

Next concrete step: parent cherry-picks this package, then coordinates the Desktop
original receipt-owner singleton/operation namespace and SessionEngine admission.
Latest delta's Android/iOS and real Host/real account acceptance remain unverified.

## Desktop original owner mobile admission — current package

Ownership for this package is limited to remote-session/desktop.ts, receipts.ts,
new mobile.ts and related integration tests plus this record. Root retains HTTP
route/Rust target/lease/controller/app ownership. A normal dependency merge of
root 7c25f587 is 04a48c00: preserve SDK 4010d555, retain root immutable artifact
registration changes, no unrelated source rewrite. Resume gate passed first at
published 4010d555; feature branch continues the same task/base/remote.

- [x] Export one existing desktopRemoteReceipts instance. Both protocols use the
  same Desktop ledger, active set and operation namespace. Legacy serialized
  receipt/digest bytes retain their original Zod canonicalization and shape.
  Mobile kinds fence receipt reads, and immutable request plus adopted file
  manifest digest rejects altered text/model/files or cross-protocol UUID reuse.
- [x] prepareDesktopRemoteMobileSession({request}) accepts only mobile.start/send.
  Authenticated target precheck precedes durable begin; begin precedes metadata
  birth/freeze or any file copy. Frozen birth is hidden exactly as legacy Desktop.
  Existing legacy sessions use original snapshot helpers and SessionStore CAS;
  ambiguous partial legacy Provider drift is rejected instead of importing newer
  Agent authority. Durable observation/model freeze survives process handoff.
- [x] handleDesktopRemoteMobileSession({request,generation,preparedSessionId?,assets?},role)
  requires the original Session owner, exact Agent/session/generation/observation,
  and single adoptPrepared before file writes/sendDesktopMessage. No new executor.
  Definite admission errors reject; possible handed-off failure remains unconfirmed.
  Duplicate/unknown operations never dispatch again. Queued send keeps original
  Desktop queue-admission semantics and does not claim turn completion.
- [x] Internal assets are trusted Rust lease metadata only. Exact ordered assetIds,
  bounded descriptors, 20MiB file/10MiB image bounds, canonical appdata store
  hex64/uploadUUID/data path, private directories, nofollow/regular/nlink/stat checks,
  bounded descriptor reads and SHA verification precede copies. MIME syntax comes
  from shared schema; known image magic/PDF signatures/text UTF-8 are checked.
  All verified bytes are copied to original attachment_ref storage or controlled
  workspace/myagents_files/remote-mobile with @relative references. No staging
  absolute path or whole binary is put in a remote DTO/user prompt.
- [x] Models reuse existing IM model-options authority, filtered to the frozen
  Provider/runtime. Agent-default catalog is read-only; send rechecks its Session
  authority and uses only a per-send model, preserving Provider/permissions.
  Suggestions require current Session sidecar, matching snapshot revisions before
  and after the existing next-prompt service. No additional recommendation provider.
- [x] Failure preserves root-compatible top-level code and typed mobile.error data.
  Query not-found returns REMOTE_OPERATION_NOT_FOUND rather than a nullable send
  receipt. Session ID is retained on actual ledger receipts. Unknown never replays.

Verification (all credential-free; no actual model invocation):
- All remote-session unit/integration tests: 9 files, 39 tests passed.
- Existing IM model-selection (17) and next-prompt service (10) unit tests passed;
  rerun alongside the 18 new mobile integration cases: 45 tests passed.
  Distinct coverage across these runs is 66 tests.
- Full repository TypeScript: tsc --noEmit --pretty false passed, zero diagnostics.
- Real child-process test imports actual Desktop registry, materialization,
  SessionStore and shared ledger; verifies one durable hidden birth, duplicate
  processing (no same-process orphan mistake), and cross-protocol UUID conflict.
  Separate real legacy authenticated Global routes and artifact resolver tests pass.
- TempDir asset cases exercise actual reads/copies/hash corruption/symlinks/order,
  metadata overflow and immutable file manifest. Engine admission is mocked in
  those behavior fixtures; no provider or executor call is claimed.

Remaining parent gates: wire/authenticate internal HTTP routes and Rust target,
retain verified scoped leases through exact admission, native/relay integration,
real model and real device/Host acceptance, main delivery and any release.
No production, real account mutation, new credentials or Xcode license action.
Next: parent cherry-picks only the new Desktop admission commit after 04a48c00,
reviews the frozen model authority/lease lifecycle and runs integrated route tests.
Requested model/effort remains gpt-6.1-sol/medium; runtime token/cost unknown.
