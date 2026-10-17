#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.dirname(mobile);
const target = process.argv[2];
const moduleDir = path.join(mobile, 'app/modules/moxbots-remote');
const manifest = path.join(mobile, 'connection/Cargo.toml');
const cargoTarget = path.join(mobile, 'connection/target');
function run(command, args, env = {}) {
  const result = spawnSync(command, args, { cwd: repo, env: { ...process.env, ...env }, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.signal})`);
}
function check(file, label) { if (!existsSync(file)) throw new Error(`${label} missing: ${file}`); }
function provenance(triple, library) {
  const inputs = ['mobile/connection', 'mobile/core', 'mobile/crypto', 'src-tauri/agent-network-crypto', 'src-tauri/agent-network-protocol', 'src-tauri/host-management-protocol'];
  const git = args => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Cannot record native source provenance');
    return result.stdout;
  };
  const files = git(['ls-files', '-z', '--', ...inputs]).split('\0').filter(Boolean).sort();
  const digest = createHash('sha256');
  for (const file of files) digest.update(file).update('\0').update(createHash('sha256').update(readFileSync(path.join(repo,file))).digest());
  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' });
  if (rustc.status !== 0) throw new Error('Cannot record Rust compiler provenance');
  const stamp = { version: 1, target: triple, sourceCommit: git(['rev-parse','HEAD']).trim(),
    sourceDirty: git(['status','--porcelain','--untracked-files=normal','--',...inputs]).trim().length > 0,
    sourceDigest: digest.digest('hex'), rustc: rustc.stdout.trim(),
    librarySha256: createHash('sha256').update(readFileSync(library)).digest('hex') };
  writeFileSync(path.join(path.dirname(library),'native-build.json'), JSON.stringify(stamp,null,2)+'\n');
}

function build(triple, env = {}, linkArgs = []) {
  const args = [linkArgs.length ? 'rustc' : 'build', '--locked', '--release', '--manifest-path', manifest, '--target', triple];
  if (linkArgs.length) args.push('--lib', '--', ...linkArgs.flatMap(arg => ['-C', `link-arg=${arg}`]));
  run('cargo', args, {
    CARGO_TARGET_DIR: cargoTarget, ...env,
  });
}
if (target === 'android') {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) throw new Error('Set ANDROID_HOME to the installed Android SDK');
  const ndk = process.env.ANDROID_NDK_HOME || path.join(sdk, 'ndk/27.1.12297006');
  const ndkHost = { darwin: 'darwin-x86_64', linux: 'linux-x86_64' }[process.platform];
  if (!ndkHost) throw new Error('Android native builds currently support macOS and Linux hosts');
  const toolchain = path.join(ndk, 'toolchains/llvm/prebuilt', ndkHost, 'bin');
  const clang = path.join(toolchain, 'aarch64-linux-android24-clang');
  const ar = path.join(toolchain, 'llvm-ar');
  check(clang, 'Android NDK clang'); check(ar, 'Android NDK ar');
  build('aarch64-linux-android', {
    CC_aarch64_linux_android: clang, AR_aarch64_linux_android: ar,
    CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: clang, ANDROID_NDK_HOME: ndk,
  }, ['-Wl,-soname,libmox_mobile_connection.so', '-Wl,-z,max-page-size=16384', '-Wl,-z,common-page-size=16384']);
  const destination = path.join(moduleDir, 'android/native/arm64-v8a');
  mkdirSync(destination, { recursive: true });
  const library = path.join(destination, 'libmox_mobile_connection.so');
  const pendingLibrary = library + '.pending';
  copyFileSync(path.join(cargoTarget, 'aarch64-linux-android/release/libmox_mobile_connection.so'), pendingLibrary);
  renameSync(pendingLibrary, library);
  provenance('aarch64-linux-android',library);
} else if (target === 'ios') {
  run('xcrun', ['--sdk', 'iphoneos', '--show-sdk-path']);
  const staging = path.join(cargoTarget, 'xcframework-stage');
  const frameworks = [];
  for (const [triple, platform] of [['aarch64-apple-ios', 'iphoneos'], ['aarch64-apple-ios-sim', 'iphonesimulator']]) {
    build(triple, { IPHONEOS_DEPLOYMENT_TARGET: '16.4' });
    const framework = path.join(staging, platform, 'MoxConnectionCore.framework');
    mkdirSync(path.join(framework, 'Headers'), { recursive: true });
    mkdirSync(path.join(framework, 'Modules'), { recursive: true });
    copyFileSync(path.join(cargoTarget, triple, 'release/libmox_mobile_connection.a'), path.join(framework, 'MoxConnectionCore'));
    provenance(triple,path.join(framework, 'MoxConnectionCore'));
    copyFileSync(path.join(mobile, 'connection/include/mox_connection.h'), path.join(framework, 'Headers/mox_connection.h'));
    writeFileSync(path.join(framework, 'Modules/module.modulemap'), 'framework module MoxConnectionCore {\n  umbrella header "mox_connection.h"\n  export *\n  module * { export * }\n}\n');
    writeFileSync(path.join(framework, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>MoxConnectionCore</string><key>CFBundleIdentifier</key><string>com.moxbots.mobile.connectioncore</string><key>CFBundleName</key><string>MoxConnectionCore</string><key>CFBundlePackageType</key><string>FMWK</string><key>CFBundleVersion</key><string>1</string><key>CFBundleSupportedPlatforms</key><array><string>${platform === 'iphoneos' ? 'iPhoneOS' : 'iPhoneSimulator'}</string></array><key>MinimumOSVersion</key><string>16.4</string></dict></plist>`);
    frameworks.push(framework);
  }
  const output = path.join(moduleDir, 'ios/Frameworks/MoxConnectionCore.xcframework');
  if (existsSync(output)) rmSync(output, { recursive: true });
  mkdirSync(path.dirname(output), { recursive: true });
  run('xcodebuild', ['-create-xcframework', ...frameworks.flatMap((f) => ['-framework', f]), '-output', output]);
} else {
  throw new Error('Usage: node mobile/scripts/build-native.mjs android|ios');
}
