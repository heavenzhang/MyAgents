Pod::Spec.new do |s|
  s.name = 'MoxBotsRemote'
  s.version = '0.1.0'
  s.summary = 'MoXBots native secure remote-session owner'
  s.description = 'Native-only account, key storage and Rust controller binding.'
  s.license = { :type => 'AGPL-3.0-only' }
  s.author = 'MoXBots'
  s.homepage = 'https://github.com/heavenzhang/MoXBots'
  s.platforms = { :ios => '16.4' }
  s.swift_version = '5.9'
  s.source = { :git => 'https://github.com/heavenzhang/MoXBots.git' }
  s.static_framework = true
  s.frameworks = 'Security', 'SystemConfiguration', 'CoreFoundation', 'Network'
  s.dependency 'ExpoModulesCore'
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.vendored_frameworks = 'ios/Frameworks/MoxConnectionCore.xcframework'
end
