#include <jni.h>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>
#include <vector>
#include "mox_connection.h"

namespace {
constexpr size_t kMaxRecord = 256 * 1024;
struct Owner {
  JavaVM *vm = nullptr;
  jobject records = nullptr;
  jmethodID read = nullptr, write = nullptr, remove = nullptr;
  MoxConnection *connection = nullptr;
};
struct ThreadEnv {
  JavaVM *vm; JNIEnv *env = nullptr; bool attached = false;
  explicit ThreadEnv(JavaVM *value): vm(value) {
    if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) == JNI_EDETACHED) {
      #if defined(__ANDROID__)
      attached = vm->AttachCurrentThread(&env, nullptr) == JNI_OK;
#else
      attached = vm->AttachCurrentThread(reinterpret_cast<void **>(&env), nullptr) == JNI_OK;
#endif
    }
  }
  ~ThreadEnv() { if (attached) vm->DetachCurrentThread(); }
};
// Scope/name originate from the validated Rust owner and contain no NULs.
jstring name(JNIEnv *env, const uint8_t *data, size_t len) {
  if (!data || !len || len > 8192 || std::memchr(data, 0, len)) return nullptr;
  return env->NewStringUTF(std::string(reinterpret_cast<const char *>(data), len).c_str());
}
bool clearException(JNIEnv *env) {
  if (!env->ExceptionCheck()) return false;
  env->ExceptionClear(); return true;
}
void erase(JNIEnv *env, jbyteArray bytes) {
  if (!bytes) return;
  const jsize size = env->GetArrayLength(bytes);
  std::vector<jbyte> zeros(static_cast<size_t>(size), 0);
  env->SetByteArrayRegion(bytes, 0, size, zeros.data());
}
int64_t read(void *context, const uint8_t *scope, size_t scopeLen,
             const uint8_t *record, size_t recordLen, uint8_t *output, size_t capacity) {
  auto *owner = static_cast<Owner *>(context); ThreadEnv thread(owner->vm);
  JNIEnv *env = thread.env;
  if (!env || !output || capacity > kMaxRecord) return -2;
  if (env->PushLocalFrame(8) != JNI_OK) return -2;
  auto s = name(env, scope, scopeLen), r = name(env, record, recordLen);
  int64_t result = -2;
  if (s && r) {
    auto bytes = static_cast<jbyteArray>(env->CallObjectMethod(owner->records, owner->read, s, r));
    if (!clearException(env)) {
      if (!bytes) result = -1;
      else {
        jsize size = env->GetArrayLength(bytes);
        if (size >= 0 && static_cast<size_t>(size) <= capacity) {
          env->GetByteArrayRegion(bytes, 0, size, reinterpret_cast<jbyte *>(output));
          if (!clearException(env)) result = size;
        }
        erase(env, bytes); clearException(env);
      }
    }
  }
  env->PopLocalFrame(nullptr); return result;
}
int32_t write(void *context, const uint8_t *scope, size_t scopeLen,
              const uint8_t *record, size_t recordLen, const uint8_t *value, size_t len) {
  auto *owner = static_cast<Owner *>(context); ThreadEnv thread(owner->vm); JNIEnv *env = thread.env;
  if (!env || !value || len > kMaxRecord || env->PushLocalFrame(8) != JNI_OK) return -1;
  auto s = name(env, scope, scopeLen), r = name(env, record, recordLen);
  auto bytes = env->NewByteArray(static_cast<jsize>(len)); int32_t result = -1;
  if (s && r && bytes) {
    env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(len), reinterpret_cast<const jbyte *>(value));
    if (!clearException(env)) {
      env->CallVoidMethod(owner->records, owner->write, s, r, bytes);
      if (!clearException(env)) result = 0;
    }
    erase(env, bytes); clearException(env);
  }
  env->PopLocalFrame(nullptr); return result;
}
int32_t remove(void *context, const uint8_t *scope, size_t scopeLen,
               const uint8_t *record, size_t recordLen) {
  auto *owner = static_cast<Owner *>(context); ThreadEnv thread(owner->vm); JNIEnv *env = thread.env;
  if (!env || env->PushLocalFrame(8) != JNI_OK) return -1;
  auto s = name(env, scope, scopeLen), r = name(env, record, recordLen); int32_t result = -1;
  if (s && r) { env->CallVoidMethod(owner->records, owner->remove, s, r); if (!clearException(env)) result = 0; }
  env->PopLocalFrame(nullptr); return result;
}
void fail(JNIEnv *env, const char *code) {
  auto type = env->FindClass("java/lang/IllegalStateException");
  if (type) env->ThrowNew(type, code);
}
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_moxbots_mobile_remote_NativeConnection_nativeCreate(JNIEnv *env, jobject,
  jbyteArray config, jobject records, jobject context) {
  if (!config || !records || mox_connection_android_init(env, context) != 0) { fail(env, "MOBILE_CONNECTION_UNAVAILABLE"); return 0; }
  auto owner = std::make_unique<Owner>();
  env->GetJavaVM(&owner->vm);
  owner->records = env->NewGlobalRef(records);
  auto type = env->GetObjectClass(records);
  owner->read = env->GetMethodID(type, "read", "(Ljava/lang/String;Ljava/lang/String;)[B");
  owner->write = env->GetMethodID(type, "write", "(Ljava/lang/String;Ljava/lang/String;[B)V");
  owner->remove = env->GetMethodID(type, "remove", "(Ljava/lang/String;Ljava/lang/String;)V");
  if (clearException(env) || !owner->records || !owner->read || !owner->write || !owner->remove) {
    if (owner->records) { env->DeleteGlobalRef(owner->records); }
    fail(env, "MOBILE_SECURE_STORE_UNAVAILABLE"); return 0;
  }
  jsize length = env->GetArrayLength(config);
  if (length < 1 || length > 64 * 1024) { env->DeleteGlobalRef(owner->records); fail(env, "MOBILE_INPUT_INVALID"); return 0; }
  std::vector<uint8_t> bytes(static_cast<size_t>(length));
  env->GetByteArrayRegion(config, 0, length, reinterpret_cast<jbyte *>(bytes.data()));
  MoxConnectionStore store{owner.get(), read, write, remove}; MoxConnectionBuffer error{};
  owner->connection = mox_connection_new(bytes.data(), bytes.size(), store, &error);
  mox_connection_buffer_free(error);
  if (!owner->connection) { env->DeleteGlobalRef(owner->records); fail(env, "MOBILE_CONNECTION_UNAVAILABLE"); return 0; }
  return reinterpret_cast<jlong>(owner.release());
}
extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_moxbots_mobile_remote_NativeConnection_nativeRequest(JNIEnv *env, jobject, jlong pointer, jbyteArray input) {
  auto *owner = reinterpret_cast<Owner *>(pointer);
  if (!owner || !input) { fail(env, "MOBILE_INPUT_INVALID"); return nullptr; }
  jsize length = env->GetArrayLength(input);
  if (length < 1 || length > 64 * 1024) { fail(env, "MOBILE_INPUT_INVALID"); return nullptr; }
  std::vector<uint8_t> bytes(static_cast<size_t>(length));
  env->GetByteArrayRegion(input, 0, length, reinterpret_cast<jbyte *>(bytes.data()));
  auto output = mox_connection_request(owner->connection, bytes.data(), bytes.size());
  jbyteArray result = nullptr;
  if (output.data && output.len <= kMaxRecord) {
    result = env->NewByteArray(static_cast<jsize>(output.len));
    if (result) env->SetByteArrayRegion(result, 0, static_cast<jsize>(output.len), reinterpret_cast<jbyte *>(output.data));
  }
  mox_connection_buffer_free(output);
  if (!result && !env->ExceptionCheck()) fail(env, "MOBILE_RESPONSE_INVALID");
  return result;
}
extern "C" JNIEXPORT void JNICALL
Java_com_moxbots_mobile_remote_NativeConnection_nativeFree(JNIEnv *env, jobject, jlong pointer) {
  std::unique_ptr<Owner> owner(reinterpret_cast<Owner *>(pointer));
  if (owner) { mox_connection_free(owner->connection); env->DeleteGlobalRef(owner->records); }
}
