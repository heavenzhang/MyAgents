package com.moxbots.mobile.remote

import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.security.MessageDigest
import java.util.ArrayDeque

/** Deterministic native owner-queue policy tests. RPC/storage are injected; no account or network is used. */
@RunWith(AndroidJUnit4::class)
class NativeUploadSchedulerInstrumentedTest {
  private val scope = "https://example.invalid\u0000synthetic-principal"
  private val target = UploadTarget("target-current", "a".repeat(64), "agent-synthetic")
  private val localId = "2cccf3c0-0531-4ca7-9d4c-d9fc4963a961"
  private val sourceBytes = byteArrayOf(1, 2, 3, 4, 5)

  private class FakeIO(private val localId: String, private val content: ByteArray) : NativeUploadScheduler.IO {
    val records = mutableMapOf<String, ByteArray>()
    val requests = mutableListOf<JSONObject>()
    val statuses = ArrayDeque<JSONObject>()
    val writesBeforeRequest = mutableListOf<Boolean>()
    var generatedUploadId = ""
    var statusDefault = "missing"
    var hideReadback = false
    var failIndexWrites = false
    var cancelUnknown = false
    override fun readRecord(scope: String, name: String) = if (hideReadback) null else records[name]?.clone()
    override fun writeRecord(scope: String, name: String, bytes: ByteArray) {
      if (failIndexWrites && name == "attachment-upload-index-v1") error("MOBILE_ATTACHMENT_UPLOAD_PERSISTENCE_UNCONFIRMED")
      records[name] = bytes.clone()
    }
    override fun removeRecord(scope: String, name: String) { records.remove(name) }
    override fun source(scope: String, localId: String): UploadSource? =
      UploadSource(localId, "synthetic.txt", "text/plain", content.size.toLong(), sha(content))
    override fun readChunk(scope: String, localId: String, offset: Long): UploadChunk {
      val source = source(scope, localId) ?: error("MOBILE_ATTACHMENT_NOT_FOUND")
      val end = minOf(content.size, offset.toInt() + 3)
      return UploadChunk(source, content.copyOfRange(offset.toInt(), end))
    }
    override fun request(targetId: String, request: JSONObject): String {
      val inner = request.getJSONObject("request")
      requests += JSONObject(inner.toString())
      writesBeforeRequest += records.isNotEmpty()
      val kind = inner.getString("kind")
      if (kind == "upload.begin") generatedUploadId = inner.getString("uploadId")
      val result = when (kind) {
        "upload.status" -> if (statuses.isNotEmpty()) statuses.removeFirst() else when (statusDefault) {
          "missing" -> JSONObject().put("kind", "error").put("version", 1).put("code", "ASSET_NOT_FOUND")
          "unknown" -> JSONObject().put("kind", "error").put("code", "MOBILE_CONNECTION_UNKNOWN")
          "ready" -> upload(inner, content.size.toLong(), "ready")
          else -> upload(inner, 0, "uploading")
        }
        "upload.begin" -> upload(inner, 0, "uploading")
        "upload.chunk" -> {
          val decoded = Base64.decode(inner.getString("dataBase64"), Base64.DEFAULT)
          upload(inner, inner.getLong("offset") + decoded.size, "uploading")
        }
        "upload.finish" -> JSONObject().put("kind", "asset").put("version", 1)
          .put("agentId", "agent-synthetic").put("uploadId", inner.getString("uploadId"))
          .put("assetId", "5c285bec-39c8-4e97-8506-bcabd9a7853e")
          .put("name", "synthetic.txt").put("mimeType", "text/plain").put("sizeBytes", content.size)
          .put("sha256", sha(content))
        "upload.cancel" -> if (cancelUnknown) JSONObject().put("kind", "error").put("code", "MOBILE_CONNECTION_UNKNOWN")
          else upload(inner, 0, "cancelled")
        else -> error("unexpected RPC $kind")
      }
      return result.toString()
    }
    private fun upload(inner: JSONObject, received: Long, state: String) = JSONObject()
      .put("kind", "upload").put("version", 1).put("agentId", "agent-synthetic")
      .put("uploadId", inner.getString("uploadId")).put("receivedBytes", received)
      .put("totalBytes", content.size).put("state", state)
    private fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
      .joinToString("") { "%02x".format(it.toInt() and 255) }
  }

  private data class Fixture(
    val io: FakeIO,
    val queued: ArrayDeque<() -> Unit>,
    val events: MutableList<JSONObject>,
    val scheduler: NativeUploadScheduler,
  ) {
    fun turn() { assertFalse("expected one scheduled owner turn", queued.isEmpty()); queued.removeFirst().invoke() }
    fun drain(limit: Int = 32) { repeat(limit) { if (queued.isEmpty()) return; turn() }; fail("scheduler failed to quiesce") }
  }

  private fun fixture(): Fixture {
    val io = FakeIO(localId, sourceBytes)
    val queue = ArrayDeque<() -> Unit>()
    val events = mutableListOf<JSONObject>()
    val scheduler = NativeUploadScheduler(io, { queue.addLast(it) }, { true }) { events += JSONObject(it.toString()) }
    return Fixture(io, queue, events, scheduler)
  }

  @Test fun startPersistsBeforeStatusThenSendsVerifiedChunkAndFinishes() {
    val f = fixture()
    val initial = f.scheduler.start(scope, target, localId)
    assertEquals("uploading", initial.getString("state"))
    assertTrue(f.io.requests.isEmpty())
    assertNotNull("UUID journal must be written before remote effect", f.io.readRecord(scope, initial.getString("identityKey").let {
      "attachment-upload-v1:$it:$localId"
    }))
    f.drain()
    assertEquals(listOf("upload.status", "upload.begin", "upload.chunk", "upload.chunk", "upload.finish"),
      f.io.requests.map { it.getString("kind") })
    assertTrue(f.io.writesBeforeRequest.all { it })
    val chunks = f.io.requests.filter { it.getString("kind") == "upload.chunk" }
    assertEquals(0L, chunks[0].getLong("offset")); assertEquals(3L, chunks[1].getLong("offset"))
    assertEquals("ready", f.events.last().getString("state"))
    assertEquals("5c285bec-39c8-4e97-8506-bcabd9a7853e", f.events.last().getString("assetId"))
  }

  @Test fun unconfirmedSecureJournalPreventsEveryRemoteEffect() {
    val f = fixture()
    f.io.hideReadback = true
    try {
      f.scheduler.start(scope, target, localId)
      fail("start must fail if its durable job binding cannot be read back")
    } catch (error: IllegalStateException) {
      assertEquals("MOBILE_ATTACHMENT_UPLOAD_PERSISTENCE_UNCONFIRMED", error.message)
    }
    assertTrue(f.io.requests.isEmpty())
    assertTrue(f.queued.isEmpty())
  }

  @Test fun unknownStatusPausesAndExplicitResumeReusesTheSameUploadId() {
    val f = fixture()
    f.io.statusDefault = "unknown"
    val first = f.scheduler.start(scope, target, localId)
    f.turn()
    assertEquals("paused", f.events.last().getString("state"))
    assertEquals("MOBILE_CONNECTION_UNKNOWN", f.events.last().getString("errorCode"))
    assertEquals(listOf("upload.status"), f.io.requests.map { it.getString("kind") })
    val uploadId = first.getString("uploadId")
    f.io.statusDefault = "found"
    // status() is deliberately read-only; only an explicit upload request resumes work.
    val resumed = f.scheduler.start(scope, target, localId)
    assertEquals(uploadId, resumed.getString("uploadId"))
    f.drain()
    assertTrue("a found status resumes the existing upload without begin", f.io.requests.none { it.getString("kind") == "upload.begin" })
    assertTrue(f.io.requests.all { it.getString("uploadId") == uploadId })
    assertEquals("ready", f.events.last().getString("state"))
  }

  @Test fun targetLossPausesAndCancelChecksRemoteStatusBeforeCancel() {
    val f = fixture()
    f.scheduler.start(scope, target, localId)
    f.turn() // ASSET_NOT_FOUND; queued BEGIN has not yet run.
    f.scheduler.validateTargets(scope, org.json.JSONArray())
    assertEquals("paused", f.events.last().getString("state"))
    assertTrue(f.io.requests.none { it.getString("kind") == "upload.begin" })

    f.io.statusDefault = "found"
    f.scheduler.status(scope, target, localId)
    f.turn() // The already queued BEGIN is fenced by target loss.
    f.turn() // Read-only status query; the scheduler is now quiescent.
    assertTrue(f.queued.isEmpty())
    f.scheduler.cancel(scope, target, localId)
    f.drain()
    val kinds = f.io.requests.map { it.getString("kind") }
    assertEquals("upload.status", kinds[kinds.lastIndex - 1])
    assertEquals("upload.cancel", kinds.last())
    assertEquals("cancelled", f.events.last().getString("state"))
  }

  @Test fun persistedPausedJobBlocksASecondUploadUntilRecovery() {
    val f = fixture()
    f.io.statusDefault = "unknown"
    f.scheduler.start(scope, target, localId)
    f.turn()
    assertEquals("paused", f.events.last().getString("state"))
    try {
      f.scheduler.start(scope, target, "7a1a2eef-3018-4f6f-bc25-3b1e4f4bf7da")
      fail("a second unresolved upload must remain blocked")
    } catch (error: IllegalStateException) {
      assertEquals("MOBILE_ATTACHMENT_UPLOAD_BUSY", error.message)
    }
    assertEquals(1, f.io.requests.size)
  }

  @Test fun explicitPauseInvalidatesQueuedChunkAndResumeChecksStatusWithoutNewId() {
    val f = fixture()
    val first = f.scheduler.start(scope, target, localId)
    val uploadId = first.getString("uploadId")
    val paused = f.scheduler.pause(scope, target, localId)
    assertEquals("paused", paused.getString("state"))
    assertEquals(uploadId, paused.getString("uploadId"))
    f.turn() // Queued status is generation-fenced; pause itself made no RPC.
    assertTrue(f.io.requests.isEmpty())
    assertTrue(f.io.requests.none { it.getString("kind") == "upload.cancel" })

    f.io.statusDefault = "found"
    val resumed = f.scheduler.start(scope, target, localId)
    assertEquals(uploadId, resumed.getString("uploadId"))
    f.drain()
    assertEquals("upload.status", f.io.requests.first().getString("kind"))
    assertTrue(f.io.requests.none { it.getString("kind") == "upload.begin" || it.getString("kind") == "upload.cancel" })
    assertTrue(f.io.requests.all { it.getString("uploadId") == uploadId })
    assertEquals("ready", f.events.last().getString("state"))
  }

  @Test fun unknownCancelResultRemainsPausedWithSameIdAndNoBlindRetry() {
    val f = fixture()
    f.io.statusDefault = "found"
    f.io.cancelUnknown = true
    val first = f.scheduler.start(scope, target, localId)
    f.turn() // status finds the existing remote transfer
    val canceled = f.scheduler.cancel(scope, target, localId)
    assertEquals("paused", canceled.getString("state"))
    f.drain()
    val kinds = f.io.requests.map { it.getString("kind") }
    assertTrue(kinds.contains("upload.cancel"))
    assertEquals("upload.status", kinds[kinds.indexOf("upload.cancel") - 1])
    assertEquals("paused", f.events.last().getString("state"))
    assertEquals("MOBILE_CONNECTION_UNKNOWN", f.events.last().getString("errorCode"))
    assertEquals(first.getString("uploadId"), f.events.last().getString("uploadId"))
    assertEquals(1, kinds.count { it == "upload.cancel" })
  }

  @Test fun indexWriteFailureLeavesNoActiveCurrentAndSameProcessRetrySchedulesStatus() {
    val f = fixture()
    f.io.failIndexWrites = true
    try {
      f.scheduler.start(scope, target, localId)
      fail("failed index reservation must reject start")
    } catch (error: IllegalStateException) {
      assertTrue(error.message?.contains("PERSISTENCE_UNCONFIRMED") == true)
    }
    assertTrue(f.io.requests.isEmpty())
    assertTrue(f.queued.isEmpty())
    assertTrue(f.io.records.isEmpty())

    f.io.failIndexWrites = false
    val retried = f.scheduler.start(scope, target, localId)
    assertEquals("uploading", retried.getString("state"))
    assertEquals(1, f.queued.size)
    assertEquals(2, f.io.records.size)
    assertNotNull(f.io.records["attachment-upload-index-v1"])
    f.turn()
    assertEquals("upload.status", f.io.requests.single().getString("kind"))
  }

  @Test fun statusOnlyNeverBeginsOrChunksAndExplicitStartResumesSameUpload() {
    val f = fixture()
    val first = f.scheduler.start(scope, target, localId)
    val queried = f.scheduler.status(scope, target, localId)
    assertEquals("paused", queried.getString("state"))
    f.drain()
    assertEquals(listOf("upload.status"), f.io.requests.map { it.getString("kind") })

    val resumed = f.scheduler.start(scope, target, localId)
    assertEquals(first.getString("uploadId"), resumed.getString("uploadId"))
    f.drain()
    assertEquals("upload.begin", f.io.requests[2].getString("kind"))
  }

  @Test fun fractionalProtocolNumbersAreRejectedWithoutAdvancingUpload() {
    val f = fixture()
    val started = f.scheduler.start(scope, target, localId)
    f.io.statuses += JSONObject().put("kind", "upload").put("version", 1.5)
      .put("agentId", target.agentId).put("uploadId", started.getString("uploadId"))
      .put("receivedBytes", 0.0).put("totalBytes", sourceBytes.size).put("state", "uploading")
    f.turn()
    assertEquals("paused", f.events.last().getString("state"))
    assertEquals("MOBILE_ATTACHMENT_UPLOAD_RESPONSE_INVALID", f.events.last().getString("errorCode"))
    assertEquals(listOf("upload.status"), f.io.requests.map { it.getString("kind") })
  }

  @Test fun readyStatusOnlyChecksExistenceAndExplicitStartReconfirmsWithFinish() {
    val f = fixture()
    val first = f.scheduler.start(scope, target, localId)
    f.drain()
    val originalAsset = f.events.last().getString("assetId")
    assertEquals("ready", f.events.last().getString("state"))

    f.io.requests.clear()
    f.io.statusDefault = "ready"
    val status = f.scheduler.status(scope, target, localId)
    assertEquals("paused", status.getString("state"))
    f.drain()
    assertEquals(listOf("upload.status"), f.io.requests.map { it.getString("kind") })
    assertEquals("ready", f.events.last().getString("state"))

    f.io.requests.clear()
    val restarted = f.scheduler.start(scope, target, localId)
    assertEquals(first.getString("uploadId"), restarted.getString("uploadId"))
    f.drain()
    assertEquals(listOf("upload.status", "upload.finish"), f.io.requests.map { it.getString("kind") })
    assertEquals(originalAsset, f.events.last().getString("assetId"))
  }

  @Test fun statusNotFoundInvalidatesCachedReadyAsset() {
    val f = fixture()
    f.scheduler.start(scope, target, localId)
    f.drain()
    assertEquals("ready", f.events.last().getString("state"))
    assertNotNull(f.events.last().getString("assetId"))

    f.io.statusDefault = "missing"
    f.scheduler.status(scope, target, localId)
    f.drain()
    assertEquals("paused", f.events.last().getString("state"))
    assertTrue(f.events.last().isNull("assetId"))
    assertEquals("MOBILE_UPLOAD_NOT_FOUND", f.events.last().getString("errorCode"))
    assertEquals("upload.status", f.io.requests.last().getString("kind"))
  }
}
