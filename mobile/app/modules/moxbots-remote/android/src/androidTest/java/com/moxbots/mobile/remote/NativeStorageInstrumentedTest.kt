package com.moxbots.mobile.remote

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.provider.MediaStore
import android.provider.OpenableColumns
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.UUID

/** Exercises the module's real Android Keystore, JNI and ContentResolver owners on an emulator. */
@RunWith(AndroidJUnit4::class)
class NativeStorageInstrumentedTest {
  private val context: Context
    get() = InstrumentationRegistry.getInstrumentation().targetContext

  @Test
  fun secureRecordsEncryptScopeAndRejectOversizeWithoutReplacingOldValue() {
    val records = SecureRecords(context)
    val scope = "instrumentation-${UUID.randomUUID()}"
    val otherScope = "instrumentation-${UUID.randomUUID()}"
    val record = "record-${UUID.randomUUID()}"
    val marker = "private-test-payload-${UUID.randomUUID()}-${UUID.randomUUID()}"
    val secret = marker.toByteArray(Charsets.UTF_8)
    val directory = File(context.noBackupFilesDir, "remote-records-v1")
    val before = directory.list()?.toSet() ?: emptySet()

    try {
      records.write(scope, record, secret)
      assertArrayEquals(secret, records.read(scope, record))
      assertEquals(null, records.read(otherScope, record))

      val newlyWritten = (directory.listFiles() ?: emptyArray())
        .filter { it.name !in before && it.isFile }
      assertTrue("expected the synthetic record to create an encrypted file", newlyWritten.isNotEmpty())
      newlyWritten.forEach { encrypted ->
        assertFalse("ciphertext must not contain the test secret", encrypted.readBytes().containsBytes(secret))
      }

      val replacement = "preserved-${UUID.randomUUID()}".toByteArray(Charsets.UTF_8)
      records.write(scope, record, replacement)
      val failure = expectFailure { records.write(scope, record, ByteArray(256 * 1024 + 1)) }
      assertTrue(failure.message.orEmpty().contains("MOBILE_RECORD_TOO_LARGE"))
      assertArrayEquals(replacement, records.read(scope, record))
    } finally {
      records.remove(scope, record)
    }
  }

  @Test
  fun nativeConnectionLoadsJniAndReportsSignedOutWithoutNetworkLogin() {
    val connection = NativeConnection(context, "https://${UUID.randomUUID()}.invalid")
    try {
      val response = JSONObject(connection.request("""{"version":1,"kind":"account.status"}"""))
      assertEquals("account", response.getString("kind"))
      assertEquals("signed-out", response.getString("state"))
      assertTrue(response.isNull("principalId"))
    } finally {
      connection.close()
    }
  }

  @Test
  fun pickedContentUriIsHashedChunkedScopedAndRemoved() {
    val scope = "attachments-${UUID.randomUUID()}"
    val otherScope = "attachments-${UUID.randomUUID()}"
    val attachments = NativeAttachments(context, scope)
    val otherAccount = NativeAttachments(context, otherScope)
    val bytes = smallPng()
    val uri = insertSynthetic("${UUID.randomUUID()}.png", "image/png") { output -> output.write(bytes) }
    var localId: String? = null
    try {
      val imported = attachments.importPicked(uri, image = true)
      val importedId = imported.getString("localId")
      localId = importedId
      assertEquals("image/png", imported.getString("mimeType"))
      assertEquals(bytes.size.toLong(), imported.getLong("sizeBytes"))
      assertEquals(sha256(bytes), imported.getString("sha256"))
      assertTrue(imported.getBoolean("image"))

      val (chunkMetadata, chunk) = attachments.readChunk(importedId, 0)
      assertEquals(importedId, chunkMetadata.getString("localId"))
      assertArrayEquals(bytes, chunk)
      val crossScopeFailure = expectFailure { otherAccount.readChunk(importedId, 0) }
      assertTrue(crossScopeFailure.message.orEmpty().contains("MOBILE_ATTACHMENT_NOT_FOUND"))

      attachments.remove(importedId)
      localId = null
      assertEquals(0, attachments.list().getJSONArray("items").length())
    } finally {
      localId?.let { runCatching { attachments.remove(it) } }
      context.contentResolver.delete(uri, null, null)
      bytes.fill(0)
    }
  }

  @Test
  fun attachmentImportRejectsFileUriEmptyOversizeAndNonImageImage() {
    val attachments = NativeAttachments(context, "rejections-${UUID.randomUUID()}")
    val syntheticUris = mutableListOf<Uri>()
    try {
      val emptyUri = insertSynthetic("${UUID.randomUUID()}.empty", "application/octet-stream") { }
        .also(syntheticUris::add)
      val largeUri = insertSynthetic("${UUID.randomUUID()}.large", "application/octet-stream") { output ->
        val block = ByteArray(64 * 1024) { 0x41 }
        try {
          var remaining = 20L * 1024 * 1024 + 1
          while (remaining > 0) {
            val count = minOf(block.size.toLong(), remaining).toInt()
            output.write(block, 0, count)
            remaining -= count
          }
        } finally {
          block.fill(0)
        }
      }.also(syntheticUris::add)
      val nonImageUri = insertSynthetic("${UUID.randomUUID()}.txt", "text/plain") { output ->
        output.write("synthetic text is not image data".toByteArray(Charsets.UTF_8))
      }.also(syntheticUris::add)
      val fileUri = Uri.fromFile(File(context.cacheDir, "synthetic-${UUID.randomUUID()}"))
      assertCode("MOBILE_ATTACHMENT_INVALID") { attachments.importPicked(fileUri, image = false) }
      assertCode("MOBILE_ATTACHMENT_EMPTY") { attachments.importPicked(emptyUri, image = false) }
      assertCode("MOBILE_ATTACHMENT_TOO_LARGE") { attachments.importPicked(largeUri, image = false) }
      assertCode("MOBILE_ATTACHMENT_IMAGE_INVALID") { attachments.importPicked(nonImageUri, image = true) }
      assertEquals(0, attachments.list().getJSONArray("items").length())
    } finally {
      syntheticUris.forEach { context.contentResolver.delete(it, null, null) }
    }
  }

  private fun insertSynthetic(name: String, mime: String, write: (java.io.OutputStream) -> Unit): Uri {
    val values = ContentValues().apply {
      put(OpenableColumns.DISPLAY_NAME, name)
      put(MediaStore.MediaColumns.MIME_TYPE, mime)
      put(MediaStore.MediaColumns.RELATIVE_PATH, "${android.os.Environment.DIRECTORY_DOWNLOADS}/MoxBotsNativeTests")
    }
    val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
      ?: error("Unable to insert synthetic MediaStore test item")
    try {
      context.contentResolver.openOutputStream(uri, "w")?.use(write)
        ?: error("Unable to open synthetic MediaStore test item")
      return uri
    } catch (failure: Throwable) {
      context.contentResolver.delete(uri, null, null)
      throw failure
    }
  }

  private fun smallPng(): ByteArray {
    val bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    return try {
      ByteArrayOutputStream().use { output ->
        check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
        output.toByteArray()
      }
    } finally {
      bitmap.recycle()
    }
  }

  private fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }

  private fun expectFailure(block: () -> Unit): IllegalStateException {
    try {
      block()
    } catch (failure: IllegalStateException) {
      return failure
    }
    throw AssertionError("Expected IllegalStateException")
  }

  private fun assertCode(code: String, block: () -> Unit) {
    val failure = expectFailure(block)
    assertTrue("expected $code, got ${failure.message}", failure.message.orEmpty().contains(code))
  }

  private fun ByteArray.containsBytes(needle: ByteArray): Boolean {
    if (needle.isEmpty() || needle.size > size) return false
    return (0..size - needle.size).any { start ->
      needle.indices.all { index -> this[start + index] == needle[index] }
    }
  }
}
