package com.moxbots.mobile.remote

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import android.system.Os
import android.system.OsConstants
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID

/** A system-picker result becomes an opaque native file ID. JS never supplies a
 * URI/path and never receives file bytes. Call only on the native owner queue. */
internal class NativeAttachments(private val context: Context, private val scope: String) {
  private val records = SecureRecords(context)
  private val directory = File(context.noBackupFilesDir, "attachment-drafts-v1/" + digest(scope.toByteArray())).apply {
    check(isDirectory || mkdirs()) { "MOBILE_ATTACHMENT_STORAGE_UNAVAILABLE" }
    Os.chmod(absolutePath, 448) // 0700
  }
  private val indexRecord = "attachment-drafts-v1"
  private fun entries(): JSONArray = records.read(scope, indexRecord)?.let { bytes ->
    try { JSONArray(String(bytes, Charsets.UTF_8)).also { check(it.length() <= 8) } }
    finally { bytes.fill(0) }
  } ?: JSONArray()
  private fun save(items: JSONArray) = records.write(scope, indexRecord, items.toString().toByteArray(Charsets.UTF_8))
  private fun file(id: String): File {
    check(UUID.fromString(id).toString() == id) { "MOBILE_ATTACHMENT_INVALID" }
    return File(directory, id)
  }

  fun importPicked(uri: Uri, image: Boolean): JSONObject {
    check(uri.scheme == "content") { "MOBILE_ATTACHMENT_INVALID" }
    val items = entries()
    check(items.length() < 8) { "MOBILE_ATTACHMENT_LIMIT" }
    val maxBytes = if (image) 10L * 1024 * 1024 else 20L * 1024 * 1024
    var name = if (image) "图片" else "文件"
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) name = cursor.getString(0) ?: name
    }
    name = name.replace(Regex("[\\p{Cc}/\\\\]"), "_").take(256).ifBlank { "文件" }
    val mime = context.contentResolver.getType(uri)?.takeIf { it.length <= 128 && !it.contains('\n') }
      ?: "application/octet-stream"
    val id = UUID.randomUUID().toString()
    val destination = file(id)
    val pending = File(directory, ".pending-$id")
    var size = 0L
    val hash = MessageDigest.getInstance("SHA-256")
    try {
      val source = context.contentResolver.openInputStream(uri) ?: error("MOBILE_ATTACHMENT_UNREADABLE")
      source.use { input -> FileOutputStream(pending).use { output ->
        Os.chmod(pending.absolutePath, 384)
        val buffer = ByteArray(24 * 1024)
        try {
          while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            if (count == 0) continue
            size += count
            check(size <= maxBytes) { "MOBILE_ATTACHMENT_TOO_LARGE" }
            hash.update(buffer, 0, count)
            output.write(buffer, 0, count)
          }
          check(size > 0) { "MOBILE_ATTACHMENT_EMPTY" }
          output.fd.sync()
        } finally { buffer.fill(0) }
      } }
      if (image) {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(pending.absolutePath, bounds)
        check(bounds.outWidth > 0 && bounds.outHeight > 0 &&
          bounds.outWidth.toLong() * bounds.outHeight <= 40_000_000 && mime.startsWith("image/")) {
          "MOBILE_ATTACHMENT_IMAGE_INVALID"
        }
      }
      Os.rename(pending.absolutePath, destination.absolutePath)
      val metadata = JSONObject().put("localId", id).put("name", name).put("mimeType", mime)
        .put("sizeBytes", size).put("sha256", hex(hash.digest())).put("image", image)
        .put("createdAt", System.currentTimeMillis())
      try { items.put(metadata); save(items); syncDirectory() }
      catch (error: Exception) { destination.delete(); throw error }
      return projection(metadata)
    } finally { pending.delete() }
  }

  fun list(): JSONObject = JSONObject().put("kind", "attachments").put("items", JSONArray().also { result ->
    val items = entries()
    for (i in 0 until items.length()) {
      val entry = items.getJSONObject(i)
      if (file(entry.getString("localId")).isFile) result.put(projection(entry))
    }
  })

  fun remove(id: String): JSONObject {
    val items = entries()
    val remaining = JSONArray()
    var found = false
    for (i in 0 until items.length()) {
      val entry = items.getJSONObject(i)
      if (entry.getString("localId") == id) found = true else remaining.put(entry)
    }
    check(found) { "MOBILE_ATTACHMENT_NOT_FOUND" }
    save(remaining)
    check(!file(id).exists() || file(id).delete()) { "MOBILE_ATTACHMENT_STORAGE_UNAVAILABLE" }
    syncDirectory()
    return JSONObject().put("kind", "attachment-removed").put("localId", id)
  }

  /** Used only by native upload scheduling; there is no byte-read JS intent. */
  fun readChunk(id: String, offset: Long): Pair<JSONObject, ByteArray> {
    val items = entries()
    val item = (0 until items.length()).map { items.getJSONObject(it) }.find { it.getString("localId") == id }
      ?: error("MOBILE_ATTACHMENT_NOT_FOUND")
    val source = file(id)
    check(offset in 0 until item.getLong("sizeBytes") && source.length() == item.getLong("sizeBytes")) {
      "MOBILE_ATTACHMENT_INVALID"
    }
    val bytes = ByteArray(minOf(24 * 1024L, source.length() - offset).toInt())
    FileInputStream(source).use { input ->
      input.channel.position(offset)
      var count = 0
      while (count < bytes.size) {
        val read = input.read(bytes, count, bytes.size - count)
        check(read > 0) { "MOBILE_ATTACHMENT_UNREADABLE" }
        count += read
      }
    }
    return item to bytes
  }

  private fun projection(item: JSONObject) = JSONObject(item.toString()).apply { remove("createdAt"); put("kind", "attachment") }
  private fun syncDirectory() {
    val fd = Os.open(directory.absolutePath, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW, 0)
    try {
      check(OsConstants.S_ISDIR(Os.fstat(fd).st_mode)) { "MOBILE_ATTACHMENT_STORAGE_UNAVAILABLE" }
      Os.fsync(fd)
    } finally { Os.close(fd) }
  }
  companion object {
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun digest(bytes: ByteArray) = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
  }
}
