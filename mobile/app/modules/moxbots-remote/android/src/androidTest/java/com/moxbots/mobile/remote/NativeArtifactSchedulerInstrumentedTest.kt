package com.moxbots.mobile.remote

import android.content.Context
import android.provider.OpenableColumns
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.security.MessageDigest
import java.util.ArrayDeque
import java.io.File
import java.util.UUID

/** Native-only cache and scheduler policy tests. All content and RPC replies are synthetic. */
@RunWith(AndroidJUnit4::class)
class NativeArtifactSchedulerInstrumentedTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()
  private val bytes = byteArrayOf(10, 20, 30, 40, 50)
  private val descriptor = ArtifactDescriptor(
    "9f6064f4-3212-4a6d-a559-a9bc105f46d9", "synthetic.txt", "text/plain", bytes.size.toLong(), bytes.sha256()
  )
  private val target = ArtifactTarget("target-current", "a".repeat(64), "agent-synthetic")

  private class FakeIO(private val descriptor: ArtifactDescriptor, private val bytes: ByteArray) {
    val calls = mutableListOf<JSONObject>()
    var malformedOffset = false
    var badHash = false
    var remoteError: JSONObject? = null
    var hasMore = false
    var nextBefore: String? = null
    fun request(_targetId: String, request: JSONObject): JSONObject {
      calls += JSONObject(request.toString())
      return when (request.getString("kind")) {
        "list" -> JSONObject().put("version", 1).put("kind", "list").put("agentId", "agent-synthetic")
          .put("sessionId", request.getString("sessionId")).put("items", JSONArray().put(JSONObject()
            .put("artifactId", descriptor.artifactId).put("name", descriptor.name).put("mimeType", descriptor.mimeType)
            .put("sizeBytes", descriptor.sizeBytes).put("sha256", descriptor.sha256)))
          .put("hasMore", hasMore).put("nextBefore", nextBefore ?: JSONObject.NULL)
        "read" -> {
          remoteError?.let { return JSONObject(it.toString()) }
          val offset = request.getLong("offset")
          val actualOffset = if (malformedOffset) offset + 0.5 else offset
          val data = bytes.copyOfRange(offset.toInt(), bytes.size)
          JSONObject().put("version", 1).put("kind", "chunk").put("agentId", "agent-synthetic")
            .put("sessionId", request.getString("sessionId")).put("artifactId", descriptor.artifactId)
            .put("offset", actualOffset).put("dataBase64", Base64.encodeToString(data, Base64.NO_WRAP))
            .put("sha256", if (badHash) "0".repeat(64) else data.sha256()).put("eof", true)
        }
        else -> error("unexpected synthetic RPC")
      }
    }
  }

  private data class Fixture(
    val scope: String,
    val records: SecureRecords,
    val io: FakeIO,
    val queued: ArrayDeque<() -> Unit>,
    val events: MutableList<JSONObject>,
    val scheduler: NativeArtifactScheduler,
  ) {
    fun turn() { assertFalse("expected an owner-queue turn", queued.isEmpty()); queued.removeFirst().invoke() }
    fun drain() { repeat(16) { if (queued.isEmpty()) return; turn() }; fail("download scheduler did not quiesce") }
  }

  private fun fixture(): Fixture {
    val scope = "https://synthetic.invalid\u0000" + UUID.randomUUID()
    val records = SecureRecords(context)
    val io = FakeIO(descriptor, bytes)
    val queued = ArrayDeque<() -> Unit>()
    val events = mutableListOf<JSONObject>()
    val cache = NativeArtifactCache(context, records, scope)
    val scheduler = NativeArtifactScheduler(cache, scope, { queued.addLast(it) }, { targetId, request -> io.request(targetId, request) }, { true }) {
      events += JSONObject(it.toString())
    }
    return Fixture(scope, records, io, queued, events, scheduler)
  }

  @Test fun downloadRequiresNativeListedDescriptorAndRejectsChangedJsMetadata() {
    val f = fixture()
    val session = "synthetic-session"
    try {
      try { f.scheduler.download(target, session, descriptor); fail("unlisted descriptor must require refresh") }
      catch (error: IllegalStateException) { assertEquals("MOBILE_ARTIFACT_REFRESH_REQUIRED", error.message) }
      assertTrue(f.io.calls.isEmpty())
      f.scheduler.list(target, session, 10, null)
      val changed = descriptor.copy(name = "other.txt")
      try { f.scheduler.download(target, session, changed); fail("JS metadata must exactly match the native list") }
      catch (error: IllegalStateException) { assertEquals("MOBILE_ARTIFACT_DESCRIPTOR_CHANGED", error.message) }
      assertEquals(listOf("list"), f.io.calls.map { it.getString("kind") })
    } finally { cleanup(f, session) }
  }

  @Test fun listPaginationMustFollowTheDurablySavedCursor() {
    val f = fixture()
    val session = "synthetic-session"
    try {
      f.io.hasMore = true
      f.io.nextBefore = "cursor-two"
      f.scheduler.list(target, session, 10, null)
      try { f.scheduler.list(target, session, 10, "forged-cursor"); fail("pagination must follow the native catalog cursor") }
      catch (error: IllegalStateException) { assertEquals("MOBILE_ARTIFACT_REFRESH_REQUIRED", error.message) }
      assertEquals(2, f.io.calls.size)
      f.io.hasMore = false
      f.io.nextBefore = null
      f.scheduler.list(target, session, 10, "cursor-two")
      assertEquals(listOf("list", "list", "list"), f.io.calls.map { it.getString("kind") })
    } finally { cleanup(f, session) }
  }

  @Test fun listDownloadStatusAndPauseAreLocalAndFinalFileIsVerified() {
    val f = fixture()
    val session = "synthetic-session"
    try {
      f.scheduler.list(target, session, 10, null)
      val started = f.scheduler.download(target, session, descriptor)
      assertEquals("downloading", started.getString("state"))
      assertEquals(listOf("list"), f.io.calls.map { it.getString("kind") })
      val id = descriptor.artifactId
      val status = f.scheduler.status(target, session, id)
      assertEquals("downloading", status.getString("state"))
      assertEquals(listOf("list"), f.io.calls.map { it.getString("kind") })
      val paused = f.scheduler.pause(target, session, id)
      assertEquals("paused", paused.getString("state"))
      assertEquals("pause invalidates the pending turn without touching the remote", 1, f.queued.size)
      assertEquals(listOf("list"), f.io.calls.map { it.getString("kind") })
      val resumed = f.scheduler.download(target, session, descriptor)
      assertEquals("downloading", resumed.getString("state"))
      f.drain()
      assertEquals(listOf("list", "read"), f.io.calls.map { it.getString("kind") })
      assertEquals("ready", f.events.last().getString("state"))
      assertEquals(bytes.size.toLong(), f.scheduler.readyFile(target, session, id).file.length())
      assertEquals(descriptor.sha256, f.scheduler.status(target, session, id).getString("sha256"))
    } finally { cleanup(f, session) }
  }

  @Test fun malformedFractionalOffsetPausesWithoutExposingUnverifiedFile() {
    val f = fixture()
    val session = "synthetic-session"
    try {
      f.scheduler.list(target, session, 10, null)
      f.io.malformedOffset = true
      f.scheduler.download(target, session, descriptor)
      f.drain()
      assertEquals("paused", f.events.last().getString("state"))
      assertEquals("MOBILE_ARTIFACT_RESPONSE_INVALID", f.events.last().getString("errorCode"))
      try { f.scheduler.readyFile(target, session, descriptor.artifactId); fail("partial artifact must not be presented") }
      catch (error: IllegalStateException) { assertEquals("MOBILE_ARTIFACT_NOT_READY", error.message) }
    } finally { cleanup(f, session) }
  }

  @Test fun unversionedConnectionFailureIsPreservedAndNeverTreatedAsAssetNotFound() {
    val f = fixture()
    val session = "synthetic-session"
    try {
      f.scheduler.list(target, session, 10, null)
      f.io.remoteError = JSONObject().put("kind", "error").put("code", "TARGET_REVOKED")
      f.scheduler.download(target, session, descriptor)
      f.drain()
      assertEquals("paused", f.events.last().getString("state"))
      assertEquals("TARGET_REVOKED", f.events.last().getString("errorCode"))
      assertEquals(listOf("list", "read"), f.io.calls.map { it.getString("kind") })
    } finally { cleanup(f, session) }
  }

  @Test fun readOnlyProviderUsesVerifiedDisplayMetadataAndNoBackupFiles() {
    val file = File(context.noBackupFilesDir, "artifacts-v1/provider-test-${UUID.randomUUID()}").apply {
      parentFile?.mkdirs(); writeBytes(bytes)
    }
    val ready = ReadyArtifactFile(file, "synthetic-name.txt", "text/plain", bytes.size.toLong(), bytes.sha256())
    val authority = context.packageName + ".moxbots.artifacts"
    try {
      assertTrue(file.canonicalPath.startsWith(context.noBackupFilesDir.canonicalPath + File.separator))
      val providerInfo = context.packageManager.resolveContentProvider(authority, 0)
      assertNotNull("native artifact provider must be declared in the instrumentation application", providerInfo)
      assertEquals(false, providerInfo!!.exported)
      assertTrue(providerInfo.grantUriPermissions)
      val uri = NativeArtifactProviderUris.issue(context, authority, ready)
      assertEquals("text/plain", context.contentResolver.getType(uri))
      context.contentResolver.query(uri, null, null, null, null)!!.use { cursor ->
        val nameColumn = cursor.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME)
        val sizeColumn = cursor.getColumnIndexOrThrow(OpenableColumns.SIZE)
        assertTrue(cursor.moveToFirst())
        assertEquals("synthetic-name.txt", cursor.getString(nameColumn))
        assertEquals(bytes.size.toLong(), cursor.getLong(sizeColumn))
      }
      val opened = context.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
      assertArrayEquals(bytes, opened)
      try { context.contentResolver.query(uri, arrayOf("_data"), null, null, null)?.close(); fail("provider must not disclose paths") }
      catch (_: IllegalArgumentException) { }
      try { context.contentResolver.openFileDescriptor(uri, "w")?.close(); fail("provider must reject write modes") }
      catch (_: java.io.FileNotFoundException) { }
      try { context.contentResolver.insert(uri, android.content.ContentValues()); fail("provider must reject insert") }
      catch (_: UnsupportedOperationException) { }
      try { context.contentResolver.update(uri, android.content.ContentValues(), null, null); fail("provider must reject update") }
      catch (_: UnsupportedOperationException) { }
      try { context.contentResolver.delete(uri, null, null); fail("provider must reject delete") }
      catch (_: UnsupportedOperationException) { }
      val forged = uri.buildUpon().appendPath("..\\secret").build()
      try { context.contentResolver.openInputStream(forged)?.close(); fail("provider must reject path traversal") }
      catch (_: java.io.FileNotFoundException) { }
    } finally { file.delete() }
  }

  @Test fun legacyFilesDirArtifactIsMigratedWithoutLosingVerifiedMetadata() {
    val scope = "https://synthetic.invalid\u0000" + UUID.randomUUID()
    val cache = NativeArtifactCache(context, SecureRecords(context), scope)
    val item = descriptor.copy(artifactId = UUID.randomUUID().toString())
    val legacyScope = scope.sha256()
    val legacyKey = "$scope\u0000${target.identityKey}\u0000migration-session\u0000${item.artifactId}"
    val legacyName = legacyKey.toByteArray().sha256()
    val old = File(File(File(context.filesDir, "artifacts-v1"), legacyScope), legacyName)
    old.parentFile?.mkdirs(); old.writeBytes(bytes)
    val records = SecureRecords(context)
    try {
      cache.reserve(scope, target.identityKey, "migration-session", item, target.agentId)
      assertArrayEquals(bytes, cache.localFile(target.identityKey, "migration-session", item.artifactId).readBytes())
      assertFalse("legacy backup-eligible copy must be removed after migration", old.exists())
      assertEquals("paused", cache.read(scope, target.identityKey, "migration-session", item.artifactId)!!.getString("state"))
    } finally {
      runCatching { cache.delete(scope, target.identityKey, "migration-session", item.artifactId) }
      runCatching { cache.localFile(target.identityKey, "migration-session", item.artifactId).delete() }
      runCatching { records.remove(scope, "artifact-cache-index-v1") }
      old.delete()
    }
  }

  @Test fun cacheRecoversEveryReservationAndRemovalCrashBoundary() {
    class SimulatedProcessStop : Error()
    fun scope() = "https://synthetic.invalid\u0000" + UUID.randomUUID()
    fun cache(scope: String, stopAt: String? = null) = NativeArtifactCache(context, SecureRecords(context), scope) { boundary ->
      if (boundary == stopAt) throw SimulatedProcessStop()
    }

    val reservationScope = scope()
    val second = descriptor.copy(artifactId = UUID.randomUUID().toString())
    try {
      try { cache(reservationScope, "reserve.index").reserve(reservationScope, target.identityKey, "crash-session", descriptor, target.agentId); fail("simulate process stop after index commit") }
      catch (_: SimulatedProcessStop) { }
      val afterIndexStop = cache(reservationScope)
      val recovered = afterIndexStop.reserve(reservationScope, target.identityKey, "crash-session", descriptor, target.agentId)
      assertEquals("paused", recovered.getString("state"))
      assertTrue("index reservation without a sealed job must be discarded", afterIndexStop.read(reservationScope, target.identityKey, "crash-session", descriptor.artifactId) != null)

      try { cache(reservationScope, "reserve.job").reserve(reservationScope, target.identityKey, "crash-session", second, target.agentId); fail("simulate process stop after job commit") }
      catch (_: SimulatedProcessStop) { }
      val afterJobStop = cache(reservationScope)
      afterJobStop.recover(reservationScope)
      assertEquals("paused", afterJobStop.read(reservationScope, target.identityKey, "crash-session", second.artifactId)!!.getString("state"))
      val active = afterJobStop.read(reservationScope, target.identityKey, "crash-session", second.artifactId)!!
      active.put("state", "downloading")
      afterJobStop.write(reservationScope, active)
      afterJobStop.recover(reservationScope)
      assertEquals("downloading", afterJobStop.read(reservationScope, target.identityKey, "crash-session", second.artifactId)!!.getString("state"))
      afterJobStop.append(target.identityKey, "crash-session", descriptor.artifactId, 0, bytes)
      val ready = afterJobStop.read(reservationScope, target.identityKey, "crash-session", descriptor.artifactId)!!
      ready.put("state", "ready").put("receivedBytes", descriptor.sizeBytes)
      afterJobStop.write(reservationScope, ready)
      afterJobStop.recover(reservationScope)
      assertEquals("ready", afterJobStop.read(reservationScope, target.identityKey, "crash-session", descriptor.artifactId)!!.getString("state"))
      assertEquals(descriptor.sha256, afterJobStop.hash(target.identityKey, "crash-session", descriptor.artifactId))
    } finally {
      runCatching { cache(reservationScope).delete(reservationScope, target.identityKey, "crash-session", descriptor.artifactId) }
      runCatching { cache(reservationScope).delete(reservationScope, target.identityKey, "crash-session", second.artifactId) }
      runCatching { SecureRecords(context).remove(reservationScope, "artifact-cache-index-v1") }
    }

    listOf("delete.marker", "delete.file", "delete.record", "delete.index").forEach { boundary ->
      val deletionScope = scope()
      val records = SecureRecords(context)
      val initial = NativeArtifactCache(context, records, deletionScope)
      val item = descriptor.copy(artifactId = UUID.randomUUID().toString())
      initial.reserve(deletionScope, target.identityKey, "delete-session", item, target.agentId)
      initial.append(target.identityKey, "delete-session", item.artifactId, 0, bytes)
      try {
        try { cache(deletionScope, boundary).delete(deletionScope, target.identityKey, "delete-session", item.artifactId); fail("simulate process stop at $boundary") }
        catch (_: SimulatedProcessStop) { }
        val restarted = cache(deletionScope)
        restarted.recover(deletionScope)
        assertNull("deleting entries must be completed during recovery at $boundary",
          restarted.read(deletionScope, target.identityKey, "delete-session", item.artifactId))
        assertEquals("paused", restarted.reserve(deletionScope, target.identityKey, "delete-session", item, target.agentId).getString("state"))
      } finally {
        runCatching { cache(deletionScope).delete(deletionScope, target.identityKey, "delete-session", item.artifactId) }
        runCatching { cache(deletionScope).localFile(target.identityKey, "delete-session", item.artifactId).delete() }
        runCatching { records.remove(deletionScope, "artifact-cache-index-v1") }
      }
    }
  }

  @Test fun targetLossAndDigestMismatchNeverProduceAReadyProjection() {
    val f = fixture()
    val session = "synthetic-session"
    try {
      f.scheduler.list(target, session, 10, null)
      f.scheduler.download(target, session, descriptor)
      f.scheduler.validateTargets(JSONArray().put(JSONObject().put("targetId", target.targetId)
        .put("identityKey", "b".repeat(64)).put("agentId", target.agentId)))
      f.drain()
      assertEquals(listOf("list"), f.io.calls.map { it.getString("kind") })
      assertEquals("paused", f.events.last().getString("state"))
      f.scheduler.download(target, session, descriptor)
      f.io.badHash = true
      f.drain()
      assertEquals(24 * 1024, f.io.calls.last().getInt("maxBytes"))
      assertEquals("paused", f.events.last().getString("state"))
      assertEquals("MOBILE_ARTIFACT_HASH_MISMATCH", f.events.last().getString("errorCode"))
      assertFalse(f.events.any { it.getString("state") == "ready" })
      assertFalse(f.events.last().has("path")); assertFalse(f.events.last().has("file"))
    } finally { cleanup(f, session) }
  }

  @Test fun identicalArtifactKeysAreIsolatedByAccountAndStableIdentity() {
    val firstScope = "https://synthetic.invalid\u0000" + UUID.randomUUID()
    val secondScope = "https://synthetic.invalid\u0000" + UUID.randomUUID()
    val firstRecords = SecureRecords(context)
    val secondRecords = SecureRecords(context)
    val first = NativeArtifactCache(context, firstRecords, firstScope)
    val second = NativeArtifactCache(context, secondRecords, secondScope)
    val otherTarget = "c".repeat(64)
    try {
      first.reserve(firstScope, target.identityKey, "scope-session", descriptor, target.agentId)
      second.reserve(secondScope, target.identityKey, "scope-session", descriptor, target.agentId)
      assertNotEquals(first.localFile(target.identityKey, "scope-session", descriptor.artifactId).absolutePath,
        second.localFile(target.identityKey, "scope-session", descriptor.artifactId).absolutePath)
      assertNull(first.read(firstScope, otherTarget, "scope-session", descriptor.artifactId))
    } finally {
      runCatching { first.delete(firstScope, target.identityKey, "scope-session", descriptor.artifactId) }
      runCatching { second.delete(secondScope, target.identityKey, "scope-session", descriptor.artifactId) }
      runCatching { firstRecords.remove(firstScope, "artifact-cache-index-v1") }
      runCatching { secondRecords.remove(secondScope, "artifact-cache-index-v1") }
    }
  }

  @Test fun cacheEnforcesPerTargetAndPerAccountQuotasBeforeReservation() {
    val scope = "https://synthetic.invalid\u0000" + UUID.randomUUID()
    val records = SecureRecords(context)
    val cache = NativeArtifactCache(context, records, scope)
    val created = mutableListOf<Pair<String, String>>()
    val accountScope = scope + "-account"
    val accountCreated = mutableListOf<Pair<String, String>>()
    try {
      repeat(10) {
        val item = descriptor.copy(artifactId = UUID.randomUUID().toString())
        cache.reserve(scope, target.identityKey, "quota-target", item, target.agentId)
        created += target.identityKey to item.artifactId
      }
      try {
        val extra = descriptor.copy(artifactId = UUID.randomUUID().toString())
        cache.reserve(scope, target.identityKey, "quota-target", extra, target.agentId)
        fail("per-target artifact limit must be enforced")
      } catch (error: IllegalStateException) { assertEquals("MOBILE_ARTIFACT_CACHE_LIMIT", error.message) }

      val accountCache = NativeArtifactCache(context, records, accountScope)
      repeat(10) { index ->
        val identity = ("%064x".format(index + 1))
        val item = descriptor.copy(artifactId = UUID.randomUUID().toString(), sizeBytes = 20L * 1024 * 1024)
        accountCache.reserve(accountScope, identity, "quota-account", item, target.agentId)
        accountCreated += identity to item.artifactId
      }
      val overLimitIdentity = "f".repeat(64)
      val overLimit = descriptor.copy(artifactId = UUID.randomUUID().toString(), sizeBytes = 1)
      try {
        accountCache.reserve(accountScope, overLimitIdentity, "quota-account", overLimit, target.agentId)
        fail("account-wide byte limit must be enforced")
      } catch (error: IllegalStateException) { assertEquals("MOBILE_ARTIFACT_CACHE_LIMIT", error.message) }
    } finally {
      created.forEach { (identity, id) -> runCatching { records.remove(scope, "artifact-v1:$identity:quota-target:$id") } }
      runCatching { records.remove(scope, "artifact-cache-index-v1") }
      accountCreated.forEach { (identity, id) -> runCatching { records.remove(accountScope, "artifact-v1:$identity:quota-account:$id") } }
      runCatching { records.remove(accountScope, "artifact-cache-index-v1") }
    }
  }

  private fun cleanup(f: Fixture, session: String) {
    runCatching { f.scheduler.pause(target, session, descriptor.artifactId) }
    runCatching { f.scheduler.remove(target, session, descriptor.artifactId) }
    runCatching { f.records.remove(f.scope, "artifact-catalog-v1:${target.identityKey}:$session") }
    runCatching { f.records.remove(f.scope, "artifact-cache-index-v1") }
  }

}

private fun ByteArray.sha256() = MessageDigest.getInstance("SHA-256").digest(this)
    .joinToString("") { "%02x".format(it.toInt() and 255) }
private fun String.sha256() = toByteArray(Charsets.UTF_8).sha256()
