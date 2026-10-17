package com.moxbots.mobile.remote

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Native-only encrypted records. The KEK is non-exportable Android Keystore AES.
 * Records live in noBackupFilesDir and bind scope+record as AEAD associated data. */
internal class SecureRecords(context: Context) {
  private val directory = File(context.noBackupFilesDir, "remote-records-v1").apply {
    check(isDirectory || mkdirs()) { "MOBILE_SECURE_STORE_UNAVAILABLE" }
  }
  private val alias = context.packageName + ".remote.records.v1"
  private val maxBytes = 256 * 1024

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(alias, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
      init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setRandomizedEncryptionRequired(true).build())
      generateKey()
    }
  }
  private fun aad(scope: String, record: String) = (scope + "\u0000" + record).toByteArray(Charsets.UTF_8)
  private fun path(scope: String, record: String): File {
    val hash = MessageDigest.getInstance("SHA-256").digest(aad(scope, record))
      .joinToString("") { "%02x".format(it.toInt() and 255) }
    return File(directory, hash)
  }
  @Synchronized fun read(scope: String, record: String): ByteArray? {
    val file = path(scope, record)
    if (!file.exists()) return null
    check(file.isFile && file.length() in 29..(maxBytes + 29).toLong()) { "MOBILE_RECORD_INVALID" }
    val encoded = file.readBytes()
    try {
      check(encoded[0] == 1.toByte()) { "MOBILE_RECORD_INVALID" }
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, encoded.copyOfRange(1, 13)))
      cipher.updateAAD(aad(scope, record))
      return cipher.doFinal(encoded, 13, encoded.size - 13)
    } finally { encoded.fill(0) }
  }
  @Synchronized fun write(scope: String, record: String, bytes: ByteArray) {
    check(bytes.size <= maxBytes) { "MOBILE_RECORD_TOO_LARGE" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    check(cipher.iv.size == 12) { "MOBILE_SECURE_STORE_UNAVAILABLE" }
    cipher.updateAAD(aad(scope, record))
    val encrypted = byteArrayOf(1) + cipher.iv + cipher.doFinal(bytes)
    val pending = File(directory, ".pending-" + UUID.randomUUID())
    try {
      FileOutputStream(pending).use { output ->
        Os.chmod(pending.absolutePath, 384) // 0600
        output.write(encrypted)
        output.fd.sync()
      }
      Os.rename(pending.absolutePath, path(scope, record).absolutePath)
      syncDirectory()
    } finally { encrypted.fill(0); pending.delete() }
  }
  @Synchronized fun remove(scope: String, record: String) {
    val file = path(scope, record)
    check(!file.exists() || file.delete()) { "MOBILE_SECURE_STORE_UNAVAILABLE" }
    syncDirectory()
  }
  private fun syncDirectory() {
    val fd = Os.open(directory.absolutePath, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW, 0)
    try {
      check(OsConstants.S_ISDIR(Os.fstat(fd).st_mode)) { "MOBILE_SECURE_STORE_UNAVAILABLE" }
      Os.fsync(fd)
    } finally { Os.close(fd) }
  }
}
