#ifndef MOX_CONNECTION_H
#define MOX_CONNECTION_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct MoxConnection MoxConnection;
typedef struct { uint8_t *data; size_t len; int32_t status; } MoxConnectionBuffer;
typedef int64_t (*MoxStoreRead)(void *, const uint8_t *,size_t,const uint8_t *,size_t,uint8_t *,size_t);
typedef int32_t (*MoxStoreWrite)(void *,const uint8_t *,size_t,const uint8_t *,size_t,const uint8_t *,size_t);
typedef int32_t (*MoxStoreRemove)(void *,const uint8_t *,size_t,const uint8_t *,size_t);
typedef struct { void *context; MoxStoreRead read; MoxStoreWrite write; MoxStoreRemove remove; } MoxConnectionStore;
/* Native only. Config {issuer:HTTPS origin,publicTlsCa:PEM|null}. Never forward
 * config/keys/store callbacks to JS. Callbacks must be thread safe, native-only,
 * durable on success, and live until free. read returns length>=0,-1 missing,
 * -2 failure; capacity=256KiB. write/remove return 0 success,-1 failure.
 * Calls must be serialized on one native worker queue, never the UI thread. */
/* Android: JNI thread must initialize verifier before first new/request. */
int32_t mox_connection_android_init(void *jni_env,void *context);
MoxConnection *mox_connection_new(const uint8_t *,size_t,MoxConnectionStore,MoxConnectionBuffer *);
/* Closed JS intent v1 -> {ok:true,value:projection} or {ok:false,error:{kind,code}}.
 * Returned buffers are Rust-owned and MUST be freed exactly once. */
MoxConnectionBuffer mox_connection_request(MoxConnection *,const uint8_t *,size_t);
void mox_connection_buffer_free(MoxConnectionBuffer);
void mox_connection_free(MoxConnection *);
#ifdef __cplusplus
}
#endif
#endif
