import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Inspect the application APK itself. Instrumentation can supply a missing
// native dependency from its own APK and hide an application packaging defect.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [apkArg, reportArg] = process.argv.slice(2);
if (!apkArg || !reportArg || process.argv.length !== 4) {
  throw new Error('Usage: node mobile/scripts/verify-android-apk.mjs APK REPORT.json; set ANDROID_BUILD_TOOLS and ANDROID_NDK_HOME');
}
const apk = path.resolve(apkArg);
const report = path.resolve(reportArg);
if (!statSync(apk).isFile() || statSync(apk).size > 512 * 1024 * 1024) throw new Error('Expected an APK file no larger than 512 MiB');
const buildTools = process.env.ANDROID_BUILD_TOOLS;
const ndk = process.env.ANDROID_NDK_HOME;
if (!buildTools || !ndk) throw new Error('Set ANDROID_BUILD_TOOLS and ANDROID_NDK_HOME to the build toolchain directories');
const host = process.platform === 'darwin' ? 'darwin-x86_64' : process.platform === 'linux' ? 'linux-x86_64' : null;
if (!host) throw new Error('APK verifier currently supports macOS and Linux hosts');
const readelf = path.join(ndk, 'toolchains/llvm/prebuilt', host, 'bin/llvm-readelf');
const rustEntry = 'lib/arm64-v8a/libmox_mobile_connection.so';
const jniEntry = 'lib/arm64-v8a/libmoxbots_mobile_jni.so';
const nativeDir = path.join(repo, 'mobile/app/modules/moxbots-remote/android/native/arm64-v8a');
const stampPath = path.join(nativeDir, 'native-build.json');
const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
if (stamp.version !== 1 || stamp.target !== 'aarch64-linux-android' || !/^[a-f0-9]{64}$/.test(stamp.librarySha256)) {
  throw new Error('Native build provenance is missing or invalid; rebuild with build-native.mjs android');
}
function run(command, args, binary = false) {
  const result = spawnSync(command, args, { cwd: repo, encoding: binary ? undefined : 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed: ${String(result.stderr).slice(0, 2000)}`);
  return result.stdout;
}
const entries = run('unzip', ['-Z1', apk]).trim().split('\n');
for (const required of [rustEntry, jniEntry]) {
  if (entries.filter(entry => entry === required).length !== 1) throw new Error(`Application APK must contain exactly one ${required}`);
}
const nativeEntries = entries.filter(entry => /^lib\/.+\.so$/.test(entry));
if (nativeEntries.length > 128 || new Set(nativeEntries).size !== nativeEntries.length || nativeEntries.some(entry => !/^lib\/arm64-v8a\/[A-Za-z0-9_.+-]+\.so$/.test(entry))) {
  throw new Error('Unexpected native library inventory for the arm64 internal build');
}
const temp = mkdtempSync(path.join(tmpdir(), 'moxbots-apk-verify-'));
const libraries = [];
try {
  const nativeLibrary = path.join(nativeDir, 'libmox_mobile_connection.so');
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  if (hash(readFileSync(nativeLibrary)) !== stamp.librarySha256) throw new Error('Native input no longer matches its build provenance');
  // Android Gradle strips symbol tables before packaging. Reproduce that exact
  // documented NDK transformation rather than accepting an unrelated binary.
  const strippedLibrary = path.join(temp, 'expected-stripped.so');
  run(path.join(ndk, 'toolchains/llvm/prebuilt', host, 'bin/llvm-strip'), ['--strip-unneeded', '-o', strippedLibrary, nativeLibrary]);
  const strippedSha256 = hash(readFileSync(strippedLibrary));
  let rustPackagingTransform = null;
  for (const entry of nativeEntries) {
    const bytes = run('unzip', ['-p', apk, entry], true);
    const digest = hash(bytes);
    if (entry === rustEntry) {
      if (digest === stamp.librarySha256) rustPackagingTransform = 'identity';
      else if (digest === strippedSha256) rustPackagingTransform = 'ndk-llvm-strip-unneeded';
      else throw new Error('Packaged Rust library matches neither the proven input nor its exact NDK stripped form');
    }
    const local = path.join(temp, path.basename(entry));
    writeFileSync(local, bytes, { flag: 'wx', mode: 0o600 });
    if (!/Machine:\s+AArch64/.test(run(readelf, ['--file-header', local]))) throw new Error(`${entry} is not an arm64 ELF library`);
    const headers = run(readelf, ['--program-headers', '--wide', local]);
    const loads = headers.split('\n').filter(line => /^\s*LOAD\s/.test(line));
    if (!loads.length || loads.some(line => {
      const alignment = Number.parseInt(line.trim().split(/\s+/).at(-1), 16);
      return !Number.isSafeInteger(alignment) || alignment < 16384 || !Number.isInteger(Math.log2(alignment));
    })) {
      throw new Error(`${entry} has ELF LOAD alignment below 16 KiB`);
    }
    const dynamic = run(readelf, ['--dynamic', local]);
    const needed = [...dynamic.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g)].map(match => match[1]);
    if (needed.some(name => /[/\\]/.test(name))) throw new Error(`${entry} contains a build-machine dependency path`);
    if (entry === rustEntry && !/\(SONAME\).*\[libmox_mobile_connection\.so\]/.test(dynamic)) throw new Error('Rust SONAME is missing');
    if (entry === jniEntry && !needed.includes('libmox_mobile_connection.so')) throw new Error('JNI is not linked to the expected Rust library');
    libraries.push({ entry, sha256: digest, needed });
  }
  run(path.join(buildTools, 'zipalign'), ['-P', '16', '-c', '4', apk]);
  const signature = run(path.join(buildTools, 'apksigner'), ['verify', '--verbose', '--print-certs', apk]);
  const value = {
    version: 1, apk, apkSha256: createHash('sha256').update(readFileSync(apk)).digest('hex'),
    nativeBuild: stamp, rustPackagingTransform, containsEmbeddedJs: entries.includes('assets/index.android.bundle'), libraries,
    zipAlignment16KiB: true, signatureVerified: true,
    signerCertificateSha256: signature.match(/Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]+)/)?.[1] ?? null,
    signingIdentity: /CN=Android Debug/.test(signature) ? 'android-debug-test-key' : 'other-verified-key',
    limitation: 'Artifact checks only; no account, Host, UI, microphone, push, store-signing or real-device acceptance is implied.',
  };
  writeFileSync(report, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`APK native inventory, provenance, ELF/ZIP alignment and signature verified; report: ${report}\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
