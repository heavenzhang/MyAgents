package com.moxbots.mobile.remote

import android.app.Activity
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/** Native-only registry; the bridge never receives the opaque URI token or a path. */
internal object NativeArtifactProviderUris {
  internal data class Entry(val file: File, val name: String, val mimeType: String, val size: Long, val sha256: String)
  private val entries = ConcurrentHashMap<String, Entry>()

  fun issue(context: Context, authority: String, artifact: ReadyArtifactFile): Uri {
    require(artifact.name.length in 1..256 && artifact.name !in setOf(".", "..") &&
      !artifact.name.any { it.isISOControl() || it == '/' || it == '\\' } &&
      artifact.mimeType.matches(Regex("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+")) &&
      artifact.sizeBytes in 1..(20L * 1024 * 1024) && artifact.sha256.matches(Regex("[0-9a-f]{64}")))
    val root = File(context.noBackupFilesDir, "artifacts-v1").canonicalFile
    val file = artifact.file.canonicalFile
    check(file.path.startsWith(root.path + File.separator) && file.isFile && file.length() == artifact.sizeBytes) {
      "MOBILE_ARTIFACT_NOT_READY"
    }
    if (entries.size >= 64) entries.keys.firstOrNull()?.let(entries::remove)
    val token = UUID.randomUUID().toString()
    entries[token] = Entry(file, artifact.name, artifact.mimeType, artifact.sizeBytes, artifact.sha256)
    return Uri.Builder().scheme("content").authority(authority).appendPath("artifact").appendPath(token).build()
  }

  internal fun lookup(context: Context?, uri: Uri): Entry {
    if (uri.scheme != "content" || uri.query != null || uri.fragment != null || uri.pathSegments.size != 2 ||
      uri.pathSegments[0] != "artifact") throw FileNotFoundException("invalid artifact URI")
    val token = uri.pathSegments[1]
    if (UUID.fromString(token).toString() != token) throw FileNotFoundException("invalid artifact token")
    val entry = entries[token] ?: throw FileNotFoundException("artifact token expired")
    val app = context ?: throw FileNotFoundException("provider unavailable")
    val root = File(app.noBackupFilesDir, "artifacts-v1").canonicalFile
    val file = entry.file.canonicalFile
    if (!file.path.startsWith(root.path + File.separator) || !file.isFile || file.length() != entry.size) {
      throw FileNotFoundException("artifact unavailable")
    }
    return entry.copy(file = file)
  }

  fun verify(entry: Entry) {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(entry.file).use { input ->
      val buffer = ByteArray(24 * 1024)
      try {
        while (true) { val size = input.read(buffer); if (size < 0) break; if (size > 0) digest.update(buffer, 0, size) }
      } finally { buffer.fill(0) }
    }
    val actual = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    if (actual != entry.sha256) throw FileNotFoundException("artifact integrity check failed")
  }
}

/** Read-only, token-scoped ContentProvider over finalized, hash-verified files in noBackupFilesDir. */
class NativeArtifactProvider : ContentProvider() {
  private var authority: String? = null
  override fun attachInfo(context: Context, info: ProviderInfo) {
    super.attachInfo(context, info)
    check(!info.exported && info.grantUriPermissions) { "MOBILE_ARTIFACT_PROVIDER_CONFIGURATION_INVALID" }
    authority = info.authority
  }
  override fun onCreate() = true
  private fun entry(uri: Uri): NativeArtifactProviderUris.Entry {
    if (uri.authority != authority) throw FileNotFoundException("invalid artifact authority")
    return NativeArtifactProviderUris.lookup(context, uri)
  }
  override fun getType(uri: Uri): String = entry(uri).mimeType
  override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor {
    if (selection != null || selectionArgs != null || sortOrder != null) throw IllegalArgumentException("unsupported query")
    val entry = entry(uri)
    val columns = projection?.toList() ?: listOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
    if (columns.isEmpty() || columns.any { it !in setOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE) }) {
      throw IllegalArgumentException("unsupported projection")
    }
    return MatrixCursor(columns.toTypedArray(), 1).apply {
      addRow(columns.map { if (it == OpenableColumns.DISPLAY_NAME) entry.name else entry.size })
    }
  }
  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") throw FileNotFoundException("read-only provider")
    val entry = entry(uri)
    NativeArtifactProviderUris.verify(entry)
    return ParcelFileDescriptor.open(entry.file, ParcelFileDescriptor.MODE_READ_ONLY)
  }
  override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException("read-only provider")
  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int =
    throw UnsupportedOperationException("read-only provider")
  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int =
    throw UnsupportedOperationException("read-only provider")
}

internal object NativeArtifactPresenter {
  fun present(activity: Activity, authority: String, resolver: android.content.ContentResolver,
    artifact: ReadyArtifactFile, share: Boolean) {
    val uri = NativeArtifactProviderUris.issue(activity, authority, artifact)
    val action = if (share) Intent.ACTION_SEND else Intent.ACTION_VIEW
    val intent = Intent(action).apply {
      if (share) {
        type = artifact.mimeType
        putExtra(Intent.EXTRA_STREAM, uri)
      } else setDataAndType(uri, artifact.mimeType)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      clipData = android.content.ClipData.newUri(resolver, artifact.name, uri)
    }
    activity.startActivity(Intent.createChooser(intent, artifact.name))
  }
}
