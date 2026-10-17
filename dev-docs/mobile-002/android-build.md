# Android 内部构建与制品核验

当前为独立的 Expo 自定义原生应用，包名 `com.moxbots.mobileinternal`。源码、APK、模拟器安装、真实账号/Host 联调、签名分发分别验收。完整进度见 [plan.md](./plan.md)。

## 构建前提

- 仓库根 `rust-toolchain.toml` 指定的 Rust；Node24、JDK21。
- `ANDROID_HOME` 指向已安装 SDK；原生构建脚本使用 NDK27.1.12297006，或明确的 `ANDROID_NDK_HOME`。Android SDK 许可须已获用户授权并由工具接受。
- 安装根项目和 `mobile/app` 的锁定依赖，安装 Rust Android target。生成的 `mobile/app/android` 和原生 `.so` 不在 Git 中。
- 在 `mobile/app` 用 Expo prebuild 生成 Android 工程；配置来自 `modules/moxbots-remote/app.plugin.js` 和模块 Gradle/CMake 源码，不修改生成工程来修复打包。
- 如完整 Xcode 的新许可仍未接受，可对普通 Git/Android 命令使用 `DEVELOPER_DIR=/Library/Developer/CommandLineTools`；这不能替代 iOS SDK 许可或构建。

## 执行

在仓库根构建 Rust 动态库，脚本生成同目录 `native-build.json`，记录 Rust 输入文件摘要、源提交、编译器及原始库 SHA-256：

```sh
node mobile/scripts/build-native.mjs android
```

在 `mobile/app` 构建应用；已运行专用测试模拟器时可附带原生回归：

```sh
./android/gradlew -p android :app:assembleDebug :moxbots-remote:connectedDebugAndroidTest --console=plain
```

回到仓库根，核验**应用 APK 本身**。配置工具目录后将报告写到一个尚不存在的 Git 外文件；脚本不覆盖已有证据：

```sh
ANDROID_BUILD_TOOLS="$ANDROID_HOME/build-tools/37.0.0" \
ANDROID_NDK_HOME="$ANDROID_HOME/ndk/27.1.12297006" \
node mobile/scripts/verify-android-apk.mjs \
  mobile/app/android/app/build/outputs/apk/debug/app-debug.apk \
  /tmp/moxbots-mobile-apk-verification.json
```

核验要求应用 APK 中同时有 JNI 和 Rust 库。Rust 字节须等于构建记录中的输入，或等于相同 NDK `llvm-strip --strip-unneeded` 的精确结果；所有已打包原生库须为 arm64、ELF LOAD 对齐至少16KiB、无构建机绝对依赖路径，APK 的16KiB ZIP对齐与签名验证均须通过。报告也标明是否包含内嵌 JS、是否使用 Android Debug 测试签名。上述检查不证明真实业务可用或商店签名合格。

## 已观察到的故障及当前证据

Instrumentation APK 自带的 Rust 库曾掩盖应用 APK 漏包；16项原生测试通过时，应用 APK 仍缺少 `libmox_mobile_connection.so`。已通过模块 `main.jniLibs` 修复；保留测试 APK 的独立打包配置。不得只凭 instrumentation 或安装成功关闭应用启动门槛。

修复后应用构建及16/16原生测试通过，制品核验通过28个原生库。当前检查记录为 `/tmp/moxbots-mobile-apk-rust-production-check.json`，APK SHA-256 为 `0e35d824a3827f7c759405708d4933d3e9ccff2f5576fd9a7db2f110b2d58377`。它使用 Debug 测试密钥、没有内嵌 JS，依赖开发服务器；不是可日常独立使用或正式上架的发行包。后续修改必须重新构建及记录实际制品摘要，不沿用此结果。

`EXPO_PUBLIC_MOBILE_QA=1` 仅用于显式 Web 合成夹具。原生运行不以夹具替代真实设备、附件、麦克风或服务端能力。独立发行包还须验证离开开发服务器后的冷启动、实际账号和 Host、授权/回执恢复、文件及语音路径；发布范围和真实设备条件仍按主任务记录执行。
