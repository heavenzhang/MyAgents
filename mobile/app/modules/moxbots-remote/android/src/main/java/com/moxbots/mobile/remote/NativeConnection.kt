package com.moxbots.mobile.remote

import android.content.Context
import org.json.JSONObject

/** Handle and record owner are private and never accessible through JS. */
internal class NativeConnection(context: Context, origin: String) {
  private val records = SecureRecords(context)
  private var handle: Long
  init {
    val config = JSONObject().put("issuer", origin).put("publicTlsCa", JSONObject.NULL)
      .toString().toByteArray(Charsets.UTF_8)
    handle = nativeCreate(config, records, context.applicationContext)
    check(handle != 0L) { "MOBILE_CONNECTION_UNAVAILABLE" }
  }
  fun request(input: String): String {
    val encoded = input.toByteArray(Charsets.UTF_8)
    require(encoded.size <= 64 * 1024 && handle != 0L) { "MOBILE_INPUT_INVALID" }
    val bytes = nativeRequest(handle, encoded)
    try {
      check(bytes.size <= 256 * 1024) { "MOBILE_RESPONSE_INVALID" }
      val envelope = JSONObject(bytes.toString(Charsets.UTF_8))
      if (envelope.optBoolean("ok")) {
        return envelope.getJSONObject("value").toString()
      }
      val code = envelope.optJSONObject("error")?.optString("code")
        ?.takeIf { it.matches(Regex("^[A-Z0-9_]{1,128}$")) } ?: "MOBILE_CONNECTION_UNAVAILABLE"
      return JSONObject().put("kind", "error").put("code", code).toString()
    } finally { bytes.fill(0) }
  }
  fun close() { if (handle != 0L) { nativeFree(handle); handle = 0L } }
  private external fun nativeCreate(config: ByteArray, records: SecureRecords, context: Context): Long
  private external fun nativeRequest(handle: Long, input: ByteArray): ByteArray
  private external fun nativeFree(handle: Long)
  companion object { init { System.loadLibrary("moxbots_mobile_jni") } }
}
