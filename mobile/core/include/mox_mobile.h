#ifndef MOX_MOBILE_H
#define MOX_MOBILE_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct MoxMobileClient MoxMobileClient;
typedef struct { uint8_t *data; size_t len; int32_t status; } MoxMobileBuffer;
/* NATIVE ONLY: credentials, trust and these functions must never be exposed to JS.
 * All calls for a client must be serialized on its native owner queue.
 * Returned buffers are Rust-owned; free exactly once with buffer_free.
 * On construction failure *error is a JSON error buffer and NULL is returned.
 * Config <=256KiB, key PKCS8 <=4096B. Caller must erase its key buffer. */
MoxMobileClient *mox_mobile_new(const uint8_t *config, size_t config_len,
  const uint8_t *pkcs8, size_t pkcs8_len, MoxMobileBuffer *error);
/* JSON <=64KiB. Result {ok:true,value:...} or {ok:false,error:{code:...}}.
 * prepare: {kind:"prepare",request:<exact RemoteSessionRequest>}
 * commit: {kind:"commit",operationId:UUID,digest:base64url-sha256}
 * request: {kind:"request",request:<read-only RemoteSessionRequest>}
 * recover: {kind:"recover",records:[<JournalRecord>]} (before connection use)
 * relay-ready: {kind:"relay-ready"} only on authenticated relay confirmation.
 * suspend: {kind:"suspend"} closes epoch permanently. New auth requires new handle.
 * asset-request: {kind:"asset-request",request:<RemoteAssetRequest version:1>}
 *   Native profile:"combined" uses ONE existing channel/owner for both approved
 *   methods; never open a second WSS or reset sequences between session and assets.
 *   First asset request is capabilities; data waits for its authenticated response.
 *   Combined binds one Agent on the first valid session/asset/recovered record.
 *   Recover this Agent's journal BEFORE any RPC, including asset capabilities.
 *   Default session-only and explicit assets-only restrictions remain unchanged.
 * status: {kind:"status"}
 * prepare returns {state:"journal-required",record:{operationId,digest,request,target,issuer}}.
 * Persist record durably in encrypted native store, THEN commit. Never auto-commit
 * recovered records. Query original receipt after reconnect. */
MoxMobileBuffer mox_mobile_call(MoxMobileClient *, const uint8_t *, size_t);
/* Full existing AgentNet binary TLS frame in/out. feed returns authenticated
 * response events only. drain returns raw binary frame (empty if none); its
 * failure is a JSON error with status=1; binary success uses status=0.
 * Feed <=256KiB. Native WSS handles outer auth/TLS with verified bootstrap. */
MoxMobileBuffer mox_mobile_feed(MoxMobileClient *, const uint8_t *, size_t);
MoxMobileBuffer mox_mobile_drain(MoxMobileClient *);
/* Native authenticated relay controls only; never expose through JS.
 * credit validates strict cumulative-byte sequence. received_credit returns
 * {sequence,receivedBytes} or null; send it after successful feed. */
MoxMobileBuffer mox_mobile_credit(MoxMobileClient *, uint64_t sequence, uint64_t received_bytes);
MoxMobileBuffer mox_mobile_received_credit(MoxMobileClient *);
void mox_mobile_buffer_free(MoxMobileBuffer);
void mox_mobile_free(MoxMobileClient *);
#ifdef __cplusplus
}
#endif
#endif
