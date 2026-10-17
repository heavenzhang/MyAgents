<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/mobile-android-validation-20261018 -->
<!-- git-project-sync-task:base=400b746a4841bab8e4b99d8f83479fd54925c205 -->
<!-- git-project-sync-task:status=in-progress -->
<!-- git-project-sync-task:scaffold=false -->

# Task: MOXBOTS-MOBILE-002 native Android validation and upload scheduler

## Objective

Add module-scoped Android instrumentation coverage, then implement the native Android+iOS attachment upload scheduler for MOXBOTS-MOBILE-002. The task branch starts at canonical `main` `400b746a4841bab8e4b99d8f83479fd54925c205`; parent dependencies were integrated through normal merges `17aa8345`, `4f730d9f`, `d3e7426f`, and `89fe7c75`. The root task will cherry-pick only this branch's native scheduler/integration commits, not these dependency merge commits.

## Acceptance criteria

- Use an AndroidX instrumented runner and stable Google Maven dependencies.
- Exercise the real Android Keystore secure-record owner, including roundtrip, scope separation, ciphertext secrecy for a synthetic marker, and oversize refusal without replacing the previous record.
- Exercise real JNI `NativeConnection` only for `account.status` and prove a new connection is signed out, without login or network requests.
- Exercise real `NativeAttachments` using synthetic items inserted through the Android system MediaStore: valid PNG import/hash/chunk, account-scope isolation, removal/list cleanup, and rejection of file URI, empty, >20 MiB, and non-image-as-image inputs.
- Run on the dedicated Android 36 emulator `emulator-5554` when the parent has completed the current Gradle build. Do not access user files or credentials.
- Implement native Android/Kotlin and iOS/Swift upload scheduling over the existing `NativeConnection` owner and typed v1 `assets` protocol. Securely persist and read back the upload binding before remote effects; use status-first recovery, bounded 24 KiB chunks, one RPC per owner turn, strict result validation, and safe pause/cancel/scope lifecycle handling.
- Accept only closed native upload intents and emit metadata-only `attachment-upload` projections; prevent local removal while an upload journal is uploading or paused.
- Support explicit local pause without remote cancel, status-first resume, true remote cancel, and paused ambiguity after unknown cancellation results. A second start against a cancelled local ID returns `MOBILE_UPLOAD_CANCELLED` so the UI can remove and reselect.
- Add injectable Android state-machine coverage for persistence/readback before remote effect, bounded chunks/finish, unknown-status recovery with stable upload ID, target loss, status-before-cancel, local pause/resume, persisted-job exclusion, and unknown-cancel recovery.

## Completed

- Added `AndroidJUnitRunner` configuration and AndroidX Test stable dependencies (`runner:1.7.0`, `core:1.7.0`, `ext:junit:1.3.0`). Versions verified against Android Developers' AndroidX Test release page on 2026-10-18.
- Added four instrumentation tests backed by synthetic UUID-named data only. Positive attachment bytes are generated as a 1×1 PNG in memory; rejection test data is inserted into test-owned MediaStore Downloads rows and deleted in `finally`.
- Implemented Android and iOS native scheduler classes and connected the Android and iOS module request/event/lifecycle paths. Source access stays in the native attachment owner; JS supplies no file path, agent, asset ID, or bytes.
- Added Android instrumentation state-machine tests using injected memory records and deterministic RPC responses. They use no account, credentials, or network.
- Kept native production edits within the assigned remote module Android/iOS directories.
- Repaired the scheduler follow-up: status is query-only and leaves resumable work paused; explicit upload rechecks server status, including ready uploads, before continuing. A missing remote upload clears a cached ready asset. Journal capacity is checked before reserving an index entry, and the job record is only written after the reservation is confirmed; a same-process retry cannot return an unscheduled active job after index-write failure.
- Added regression cases for index-write failure and same-process retry, status without upload mutations, fractional protocol integers, and ready-asset status/reconfirmation behavior. Android module events now use an explicit metadata-only map projection with JSON null values translated to Kotlin null. Wrapper target changes and typed stop requests fence queued uploads.
- Corrected two scheduler tests after root's integrated instrumented run: status remains query-only, so the unknown-status case now resumes with an explicit `start()`; the target-loss case explicitly drains both the stale fenced `BEGIN` and read-only `QUERY` callbacks before cancellation. The old `drain(1)` failure was a test harness expectation error: one queued stale callback plus one query callback were present, so the queue was not expected to be empty after one turn. Coverage still verifies target loss, query-only behavior, and status-before-cancel.

## Verification

- `git diff --check` passed for current edits.
- Root's integrated Android instrumentation run compiled production and tests and executed 16 tests; 14 passed, while two tests failed due to stale test expectations described above. The corrected test source has not yet been rerun. Root owns the serial Gradle process; this task does not start a concurrent Gradle invocation.
- Root's integrated Gradle build reached `:moxbots-remote:compileDebugKotlin` and failed on nullable `JSONObject?` dereferences at `MoxBotsRemoteModule.kt:49` and `:51`; this task now uses safe calls. That same compile has not been rerun. The failure log is `/tmp/moxbots-mobile-upload-native-repair-instrumentation.log` on the root build host.
- iOS compilation and device verification remain unrun because the Xcode license prompt is pending; no license was accepted and no real-device upload behavior is claimed.
- The dedicated emulator is designated for later validation; no real-device microphone, speech, account, or Host behavior is claimed by these storage/JNI tests.

## Blockers and unknowns

- Android instrumentation execution awaits the parent's active Gradle build and run window. Parent reports Keystore and three MediaStore tests passed; JNI startup currently fails due to an absolute build-host library path, and the parent owns the CMake repair. No Google login, account creation, login endpoint, or external service is used by our tests.
- The authoritative Rust remote-assets v1 protocol emits typed `ASSET_NOT_FOUND` with `version: 1`; both native schedulers require the exact three-field versioned result before allowing `upload.begin`.
- The task validates only these Android native owners in an emulator; it is not physical-device or production acceptance.

## Next step

Root should compile the integrated Android module and run the instrumented scheduler regressions serially against `emulator-5554`, then append the exact command/output. Root reviews and cherry-picks only this task's native scheduler/module integration commits; iOS still needs a future licensed Xcode/device verification.
