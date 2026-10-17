const { withAndroidManifest, withInfoPlist, withProjectBuildGradle, withGradleProperties } = require('expo/config-plugins');

/** Permissions belong to the installed internal app, requested only on a mic tap. */
module.exports = function withMoxBotsRemote(config) {
  config = withGradleProperties(config, (entry) => {
    // The internal Rust/JNI artifact and dedicated test AVD are arm64. Do not
    // advertise installable ABIs for which the app has no native controller.
    entry.modResults = entry.modResults.filter((item) => item.type !== 'property' || item.key !== 'reactNativeArchitectures');
    entry.modResults.push({ type: 'property', key: 'reactNativeArchitectures', value: 'arm64-v8a' });
    return entry;
  });
  config = withProjectBuildGradle(config, (entry) => {
    // App runtime dependencies resolve in the consuming application project,
    // so a Maven declaration in the native library alone is insufficient.
    const block = `// moxbots-verifier-repository:start
def moxMetadata = new groovy.json.JsonSlurper().parseText(providers.exec {
  commandLine 'cargo', 'metadata', '--locked', '--format-version', '1', '--filter-platform',
    'aarch64-linux-android', '--manifest-path', new File(rootDir, '../../connection/Cargo.toml').canonicalPath
}.standardOutput.asText.get())
def moxVerifiers = moxMetadata.packages.findAll { it.name == 'rustls-platform-verifier-android' }
if (moxVerifiers.size() != 1) throw new GradleException('Expected one locked Android TLS verifier')
def moxVerifierMaven = new File(new File(moxVerifiers.first().manifest_path).parentFile, 'maven')
allprojects {
  repositories {
    maven {
      url = moxVerifierMaven.toURI()
      content { includeModule('rustls', 'rustls-platform-verifier') }
      metadataSources { mavenPom(); artifact() }
    }
  }
}
// moxbots-verifier-repository:end`;
    const marker = /\/\/ moxbots-verifier-repository:start[\s\S]*?\/\/ moxbots-verifier-repository:end/g;
    entry.modResults.contents = marker.test(entry.modResults.contents)
      ? entry.modResults.contents.replace(marker, block)
      : entry.modResults.contents + '\n' + block + '\n';
    return entry;
  });
  config = withInfoPlist(config, (entry) => {
    entry.modResults.NSMicrophoneUsageDescription = '用于录制你主动发起的语音输入。';
    entry.modResults.NSSpeechRecognitionUsageDescription = '将语音转换为可编辑的消息草稿。';
    entry.modResults.MoxBotsServiceOrigin = 'https://140.143.183.232';
    return entry;
  });
  return withAndroidManifest(config, (entry) => {
    const manifest = entry.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) throw new Error('MoxBots native application manifest missing');
    const permissions = manifest['uses-permission'] ?? [];
    if (!permissions.some((item) => item.$?.['android:name'] === 'android.permission.RECORD_AUDIO')) {
      permissions.push({ $: { 'android:name': 'android.permission.RECORD_AUDIO' } });
    }
    manifest['uses-permission'] = permissions;
    const queries = manifest.queries ?? [];
    if (!queries.some((query) => query.intent?.some((intent) => intent.action?.some((action) =>
      action.$?.['android:name'] === 'android.speech.RecognitionService')))) {
      queries.push({ intent: [{ action: [{ $: { 'android:name': 'android.speech.RecognitionService' } }] }] });
    }
    manifest.queries = queries;
    const metadata = application['meta-data'] ?? [];
    const key = 'com.moxbots.mobile.SERVICE_ORIGIN';
    const existing = metadata.find((item) => item.$?.['android:name'] === key);
    if (existing) existing.$['android:value'] = 'https://140.143.183.232';
    else metadata.push({ $: { 'android:name': key, 'android:value': 'https://140.143.183.232' } });
    application['meta-data'] = metadata;
    const providers = application.provider ?? [];
    const providerName = 'com.moxbots.mobile.remote.NativeArtifactProvider';
    const providerAuthority = '${applicationId}.moxbots.artifacts';
    // Replace the earlier FileProvider registration (if prebuild is incremental).
    application.provider = providers.filter((item) => !(item.$?.['android:authorities'] === providerAuthority &&
      item.$?.['android:name'] === 'androidx.core.content.FileProvider'));
    const existingProvider = application.provider.find((item) => item.$?.['android:name'] === providerName &&
      item.$?.['android:authorities'] === providerAuthority);
    const artifactProvider = existingProvider ?? { $: {
      'android:name': providerName,
      'android:authorities': providerAuthority,
      'android:exported': 'false',
      'android:grantUriPermissions': 'true',
    } };
    artifactProvider.$['android:exported'] = 'false';
    artifactProvider.$['android:grantUriPermissions'] = 'true';
    if (!existingProvider) application.provider.push(artifactProvider);
    return entry;
  });
};
