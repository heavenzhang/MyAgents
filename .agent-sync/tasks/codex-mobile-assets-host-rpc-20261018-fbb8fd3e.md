<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/mobile-assets-host-rpc-20261018 -->
<!-- git-project-sync-task:base=afdb2f0c04b22f6db3793132a046a84c6efadf60 -->
<!-- git-project-sync-task:status=in-progress -->

# MOXBOTS-MOBILE-002 Host asset RPC adapter

## Objective

Connect `session.assets.v1` to the existing Host owner and private native AssetStore without changing `session.remote/v1` or accepting caller-provided filesystem paths. Repository: `https://github.com/heavenzhang/MoXBots.git`. This branch is based on the root integration branch at `afdb2f0c04b22f6db3793132a046a84c6efadf60`, intentionally not the current canonical `main`. Root owns Cargo dependency wiring, actor dispatch, native store lifecycle and internal resolver route; this branch owns the target adapter, owner resolver, focused tests, and approved helper/module changes.

## Acceptance criteria

- [x] Verify each RPC against the authoritative desktop Agent/session owner before accessing the private store.
- [x] Derive Store scope from current account identity and authenticated TLS peer/local device scopes.
- [x] Resolve list entries only from original SessionStore/overlay and registered tool-attachment owner; forward owner cursor unchanged and preserve pagination.
- [x] Read/upload bytes only through native private AssetStore APIs, running filesystem work on blocking workers.
- [x] Add focused tests for valid owner-derived output and rejection of cross-session/arbitrary paths.
- [ ] Root integrates Cargo/actor/Store/route changes and runs the full Rust gate; incoming upload-to-SessionEngine association requires a future versioned method.
- [x] Commit and push only this branch's files for root integration.

## Completed

- Added `src/server/remote-session/assets.ts`: checks exact current SessionEngine session, visible SessionStore history, enabled/visible Agent and workspace association; resolves only attachment references in original assistant tool blocks; binds trusted-root file paths to the exact sanitized session/turn/filename in `refPath`, canonicalizes within that root, checks external registry entries, regular-file type and 20 MiB bounds; uses opaque owner message-anchor cursors.
- Added `src-tauri/src/agent_network/remote_assets_target.rs`: imports `AssetScope` from its actual `moxbots_asset_store` owner, preserves session id ownership across `spawn_blocking`, validates request/account lifetime and authenticated scope, prechecks Agent/session on every request, and runs Store I/O in blocking workers. List resolves through original session owner, registers outputs idempotently, and returns owner cursor. Allowlisted Store domain errors are typed `RemoteAssetResult::Error`; scope/auth/infrastructure errors remain outer failures.
- Made approved `post/global/session` helpers `pub(super)` and declared the adapter module.
- Added focused integration tests for real temporary `root/session/turn/file` resolution, current ref paired with foreign saved path, encoded traversal turn id, cross-session reference, arbitrary external path and workspace mismatch. Added native adapter unit coverage for typed `ASSET_NOT_FOUND` mapping and scope/infrastructure error exclusion.
- Review fixes bind every trusted `savedPath` to the sanitized `sessionId` and decoded `turnId` named in the attachment reference; malformed turn identifiers fail before registry lookup. Typed AssetStore errors are allowlisted; `ASSET_NOT_FOUND` is returned only as `RemoteAssetResult::Error`, while scope/auth and infrastructure failures stay outer errors and all typed results pass the post-operation account/lifetime guard.

## Verification

- Node 24 focused Vitest: `src/server/remote-session/assets.integration.test.ts`, **3 passed**. Cases include a real temporary `root/session/turn/file`, current ref paired with a foreign saved path, encoded traversal, cross-session reference, arbitrary external path, and workspace mismatch.
- Full `tsc --noEmit`, focused ESLint, test classification (399 server tests: 106 integration, 6 credentialed), `rustfmt --check` for the adapter, and `git diff --check`: passed.
- Previous `project-sync handoff` confirmed clean worktree and remote branch at `04dbfc73acfdf0f2f353a18a1ca2c9615e03cc90`; this review-fix commit still needs a fresh handoff gate.
- Rust `cargo check --manifest-path src-tauri/Cargo.toml --lib` was retried with the specified `DEVELOPER_DIR` and `SDKROOT`, using a temporary local AssetStore dependency. Required system headers resolved, but macOS dependency build stopped in `apple-metal`/`apple-cf` Swift PackageDescription manifest linking before reaching the adapter. The added native adapter unit test is therefore not run, and no real Host integration test was run. Temporary Cargo manifest/lockfile changes were removed.
- The focused test reused the already available ignored dependency tree through a temporary symlink; the link was removed after tests. No dependency installation occurred.

## Blockers and unknowns

- Current canonical `main` (`b9857cff181cdbd7139ce861443de88b43ff6a18`) diverged from the authorized root task base; do not rebase or merge it in this worker branch. Root will integrate into its current mobile task branch.
- Rust compilation remains unverified because platform Swift package build failed before adapter type checking; root owns the full integrated Cargo check.
- No real Host/account/remote peer was exercised; the native unit test covers only typed error mapping. Root must verify the integrated response carries the original request ID and that exact typed `ASSET_NOT_FOUND` recovers an UNKNOWN upload status.
- Incoming attachment upload admission into an existing SessionEngine send is intentionally outside this RPC adapter because v1 has no association method; add it only through a new versioned protocol method.
- A dormant session without an owner dispatch fails closed with `TARGET_OWNER_UNAVAILABLE`.

## Next step

Root integrates this worker branch into the mobile task branch and runs the full Cargo gate in its build-capable environment.
