<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/mobile-artifact-native-20261018 -->
<!-- git-project-sync-task:base=400b746a4841bab8e4b99d8f83479fd54925c205 -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# Task: Native mobile artifact download and verified local preview

## Objective

Add native-only mobile artifact listing, verified download, local cache lifecycle, and operating-system preview/share for Android and iOS. Keep app JavaScript limited to strict descriptors and opaque state; use the existing NativeConnection assets owner and current approved target/session authority. No deployment, credentials, account changes, or user-file access.

This task starts from canonical main `400b746a4841bab8e4b99d8f83479fd54925c205`. Native mobile foundations and app upload handling are brought in as an ordinary dependency merge from parent integration `8e38f61984bc4d9e027f0b10b0cdea3c2e97dc44`; root will cherry-pick only this task's implementation commit(s), not the dependency merge.

## Acceptance criteria

- Closed v1 intents: `artifact.list`, `artifact.download`, local/query-only `artifact.status`, `artifact.pause`, `artifact.remove`, and native `artifact.preview`/`artifact.share`.
- Remote access uses only existing `assets.list` and `assets.read`; no new remote status protocol. Status never advances downloads. Explicit download/resume revalidates the exact descriptor and current approved target, then validates each read offset, per-chunk digest, final length, and whole-file SHA-256.
- Durable account-scoped metadata and private cache are verified before remote effects. Cache identity is account scope + stable identityKey + sessionId + artifactId; targetId is current approved routing data only. Enforce 20 MiB per artifact, 200 MiB per account, and at most 10 cached artifacts per target.
- Metadata-only `artifact-download` projections/events carry current targetId, identityKey, agentId, sessionId, artifactId, descriptor name/mimeType/sha256, state, receivedBytes, totalBytes, and errorCode. Never return file path, URI, bytes, or base64 to JS.
- Pause, background, account/target change, and destruction fence subsequent owner turns and late callbacks. Preview/share/remove use only complete hash-verified files; Android uses a token-scoped read-only provider grant, iOS uses QuickLook/native share UI. No caller-controlled paths or arbitrary URL schemes.
- Add deterministic injected state-machine/storage tests for strict schema and scope, bounded reads, integrity mismatch, resume/status/pause, quota, and OS presenter gating. Do not run Gradle concurrently with root's serial build.

## Completed

- Verified project-sync observe at `e04eadd686e05f6a79fad47289e0e66ced7eec4f`; canonical `main` remains `400b746a4841bab8e4b99d8f83479fd54925c205`.
- Created this isolated task branch from canonical main and passed `start` and `task-init` gates.
- Merged the reviewed parent native upload dependency `8e38f61984bc4d9e027f0b10b0cdea3c2e97dc44` normally, then merged reviewed mobile UI/native dependency branch `55771134560bb5aa00a2d4fe7e3cd2e5c4801f48` normally after rechecking `origin/main` (still the recorded `400b746a4841bab8e4b99d8f83479fd54925c205`). The UI dependency is in its own merge commit and will not be included in the artifact implementation cherry-pick.
- Parent found the production APK lacked the imported Rust connection library. Added `main.jniLibs.srcDirs = ['native']` while preserving instrumentation packaging in focused commit `101a77a056cdb56fdf888734af4321644db3171c`. Parent cherry-picked it as `8effec3b` and reported production APK packaging checks plus the existing 16 instrumentation tests passed; report: `/tmp/moxbots-mobile-apk-rust-production-check.json`.
- Implemented native Android/iOS `artifact.*` dispatch, descriptor catalog persistence, scoped private file cache, bounded owner-queue reads, integrity checks, local status/pause/remove, and OS preview/share presenters. Native list pages are encrypted and read-back verified before returning descriptors; subsequent pages must follow the saved cursor. Download requires exact equality with the native catalog descriptor before reserving storage or issuing a read.
- Added synthetic Android instrumentation cases for native descriptor authorization, pagination cursor fencing, read-only status/pause, explicit resume, fractional-offset rejection, hash mismatch, target loss, stable identity/account cache isolation, and both cache quotas. They have not yet been run by this task; root owns the serial Gradle window.
- Preserved canonical uppercase outer `NativeConnection` errors (including account/target/host-management codes) as failures that pause local scheduling; only an exact versioned `ASSET_*` error is accepted as the Host asset API's typed error shape. Added a synthetic regression for unversioned `TARGET_REVOKED`.
- Module config adds a non-exported read-grant-only artifact provider. JS projections contain descriptors/state only, never filesystem paths, provider URIs, or bytes.
- Follow-up repair moves Android artifact bytes into `noBackupFilesDir` while retaining and lazily migrating legacy `filesDir` cache files; it no longer changes app-wide backup attributes. Android presents through a non-exported, grant-only custom provider that serves only an issued opaque token and gets display name/MIME from the verified descriptor. Provider exposes only `_display_name` and `_size`, read mode, and rechecks length/hash on open.
- Android and iOS cache recovery now reconciles missing reservation records from the durable index and finishes durable `deleting` markers without dropping valid paused/downloading/ready records. Synthetic Android tests inject process-stop failures after reservation-index/job writes and each removal boundary, then reopen a fresh cache instance and verify recovery.
- Provider integration tests query `ContentResolver.getType`, display name and size, open verified contents, reject `_data`, write modes, mutating provider calls, and traversal-shaped URIs. A migration test confirms prior scoped files are moved into the no-backup cache without losing their secure metadata.

## Verification

- `node --check mobile/app/modules/moxbots-remote/app.plugin.js` and `git diff --check` pass after the final source changes.
- Android artifact implementation and expanded provider/recovery instrumentation cases await parent serial Gradle compile/run; this task did not start Gradle. The parent reported the initial artifact compile failure at private descriptor helper access; this source has now been corrected with file-level strict parsing helpers, pending the next parent build.
- Parent verified the earlier JNI packaging repair in an actual debug APK, including native dependency provenance and alignment. That evidence predates the artifact code and does not validate artifact behavior.
- Swift parsing/compilation is blocked because the machine has not accepted the Xcode license. This task did not accept it. iOS source/runtime behavior remains unverified.
- Physical-device, real Host artifact, and user-session acceptance are outside this task unless separately assigned.

## Blockers and unknowns

- Android instrumentation must compile and pass in the root-owned serial Gradle run. Any failures require preserving reproduction evidence and repairing only owned native files.
- iOS compile/device verification remains open until the license is handled by the user/authorized build owner.

## Next step

Run static diff review, commit only the artifact module files and task record, then hand the implementation commit to root for serial Android compilation/instrumentation. Report iOS license limitation and keep real Host/device verification explicitly open.
