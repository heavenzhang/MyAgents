package com.moxbots.mobile.remote

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID

internal data class UploadTarget(val targetId: String, val identityKey: String, val agentId: String)
internal data class UploadSource(val localId: String, val name: String, val mimeType: String, val sizeBytes: Long, val sha256: String)
internal data class UploadChunk(val source: UploadSource, val bytes: ByteArray)

/** Small owner-queue state machine. One bounded native assets RPC is sent per turn. */
internal class NativeUploadScheduler(
  private val io: IO,
  private val schedule: (() -> Unit) -> Unit,
  private val allowed: () -> Boolean,
  private val onChanged: (JSONObject) -> Unit,
) {
  interface IO {
    fun readRecord(scope: String, name: String): ByteArray?
    fun writeRecord(scope: String, name: String, bytes: ByteArray)
    fun removeRecord(scope: String, name: String)
    fun source(scope: String, localId: String): UploadSource?
    fun readChunk(scope: String, localId: String, offset: Long): UploadChunk
    fun request(targetId: String, request: JSONObject): String
  }

  private data class Job(
    val scope: String,
    val record: String,
    val localId: String,
    var targetId: String,
    val identityKey: String,
    val agentId: String,
    val uploadId: String,
    val name: String,
    val mimeType: String,
    val totalBytes: Long,
    val sha256: String,
    var receivedBytes: Long = 0,
    var state: String = "uploading",
    var assetId: String? = null,
    var errorCode: String? = null,
  )

  private enum class Step { STATUS, QUERY, BEGIN, CHUNK, FINISH, CANCEL_STATUS, CANCEL }
  private var current: Job? = null
  private var currentStep = Step.STATUS
  private var generation = 0L

  fun start(scope: String, target: UploadTarget, localId: String): JSONObject {
    validateTarget(target)
    requireUuid(localId, "MOBILE_ATTACHMENT_INVALID")
    val source = io.source(scope, localId) ?: error("MOBILE_ATTACHMENT_NOT_FOUND")
    validateSource(source)
    val key = recordName(target.identityKey, localId)
    val existing = load(scope, key)
    if (existing != null) verifyBinding(existing, target, source)
    if (existing?.state == "cancelled") error("MOBILE_UPLOAD_CANCELLED")
    ensureNoOtherActive(scope, key)
    val job = existing ?: Job(
      scope = scope, record = key, localId = localId, targetId = target.targetId,
      identityKey = target.identityKey, agentId = target.agentId,
      uploadId = UUID.randomUUID().toString(), name = source.name, mimeType = source.mimeType,
      totalBytes = source.sizeBytes, sha256 = source.sha256,
    )
    current?.let { active ->
      if (active.state == "uploading" && active.record != job.record) error("MOBILE_ATTACHMENT_UPLOAD_BUSY")
      if (active.scope == job.scope && active.record == job.record &&
        active.targetId == target.targetId && active.state == "uploading") return projection(active)
      generation++
      if (active.state == "uploading") pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED")
    }
    job.targetId = target.targetId // Current approved opaque ID may change after process restoration.
    job.state = "uploading"
    job.errorCode = null
    job.assetId = null
    currentStep = Step.STATUS
    persist(job)
    current = job
    emit(job)
    scheduleStep()
    return projection(job)
  }

  fun status(scope: String, target: UploadTarget, localId: String): JSONObject {
    validateTarget(target)
    requireUuid(localId, "MOBILE_ATTACHMENT_INVALID")
    val key = recordName(target.identityKey, localId)
    val job = load(scope, key) ?: error("MOBILE_ATTACHMENT_UPLOAD_NOT_FOUND")
    val source = io.source(scope, localId)
    if (source == null) {
      if (job.state == "ready" || job.state == "cancelled") return projection(job)
      error("MOBILE_ATTACHMENT_NOT_FOUND")
    }
    validateSource(source)
    verifyBinding(job, target, source)
    ensureNoOtherActive(scope, job.record)
    current?.let { active ->
      if (active.state == "paused" && currentStep in setOf(Step.CANCEL_STATUS, Step.CANCEL)) {
        error("MOBILE_ATTACHMENT_UPLOAD_BUSY")
      }
      if (active.state == "uploading" && (active.scope != job.scope || active.record != job.record)) {
        pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED")
      }
      generation++
    }
    job.targetId = target.targetId
    if (job.state == "cancelled") return projection(job)
    val wasReady = job.state == "ready"
    job.state = if (wasReady) "ready" else "paused"
    currentStep = Step.QUERY
    current = job
    persist(job)
    scheduleStep()
    val snapshot = projection(job)
    if (wasReady) snapshot.put("state", "paused").put("assetId", JSONObject.NULL)
    return snapshot
  }

  fun cancel(scope: String, target: UploadTarget, localId: String): JSONObject {
    validateTarget(target)
    requireUuid(localId, "MOBILE_ATTACHMENT_INVALID")
    val job = load(scope, recordName(target.identityKey, localId)) ?: error("MOBILE_ATTACHMENT_UPLOAD_NOT_FOUND")
    val source = io.source(scope, localId)
    if (source == null) {
      if (job.state == "ready" || job.state == "cancelled") return projection(job)
      error("MOBILE_ATTACHMENT_NOT_FOUND")
    }
    validateSource(source)
    verifyBinding(job, target, source)
    ensureNoOtherActive(scope, job.record)
    current?.let { active ->
      if (active.record != job.record && active.state == "uploading") error("MOBILE_ATTACHMENT_UPLOAD_BUSY")
      if (active.state == "uploading") pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED")
    }
    if (job.state == "ready" || job.state == "cancelled") return projection(job)
    job.targetId = target.targetId
    current = job
    generation++ // Invalidates an already queued continuation; an in-flight RPC remains bounded by the SDK.
    currentStep = Step.CANCEL_STATUS
    job.state = "paused"
    job.errorCode = null
    persist(job); emit(job); scheduleStep()
    return projection(job)
  }

  fun pause(scope: String, target: UploadTarget, localId: String): JSONObject {
    validateTarget(target)
    requireUuid(localId, "MOBILE_ATTACHMENT_INVALID")
    val key = recordName(target.identityKey, localId)
    val job = load(scope, key) ?: error("MOBILE_ATTACHMENT_UPLOAD_NOT_FOUND")
    val source = io.source(scope, localId)
    if (source == null) {
      if (job.state == "ready" || job.state == "cancelled") return projection(job)
      error("MOBILE_ATTACHMENT_NOT_FOUND")
    }
    validateSource(source)
    verifyBinding(job, target, source)
    ensureNoOtherActive(scope, key)
    if (job.state == "ready" || job.state == "cancelled") return projection(job)
    current?.let { active ->
      if (active.record != key && (active.state == "uploading" || active.state == "paused")) error("MOBILE_ATTACHMENT_UPLOAD_BUSY")
    }
    job.targetId = target.targetId
    job.state = "paused"
    job.errorCode = null
    generation++ // The current bounded RPC may return; no next owner turn can run.
    currentStep = Step.STATUS
    current = job
    persist(job); emit(job)
    return projection(job)
  }

  fun pause(code: String? = null) {
    val job = current ?: return
    if ((job.state == "paused" || job.state == "ready") && currentStep == Step.QUERY) {
      generation++
      currentStep = Step.STATUS
      return
    }
    if (job.state == "paused" && currentStep in setOf(Step.QUERY, Step.CANCEL_STATUS, Step.CANCEL)) {
      generation++
      currentStep = Step.STATUS
      job.errorCode = code
      persist(job)
      emit(job)
      return
    }
    if (job.state != "uploading") return
    generation++
    job.state = "paused"
    job.errorCode = code
    persist(job)
    emit(job)
  }

  fun pauseForTarget(targetId: String) {
    if (current?.let { (it.state == "uploading" || (it.state in setOf("paused", "ready") && currentStep in setOf(Step.QUERY, Step.CANCEL_STATUS, Step.CANCEL))) && it.targetId != targetId } == true) {
      pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED")
    }
  }

  fun pauseUnlessScope(scope: String) {
    if (current?.let { it.scope != scope && (it.state == "uploading" || (it.state in setOf("paused", "ready") && currentStep in setOf(Step.QUERY, Step.CANCEL_STATUS, Step.CANCEL))) } == true) {
      pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED")
    }
  }

  fun validateTargets(scope: String, items: JSONArray) {
    val job = current ?: return
    if (job.scope != scope || (job.state != "uploading" && !(job.state in setOf("paused", "ready") && currentStep in setOf(Step.QUERY, Step.CANCEL_STATUS, Step.CANCEL)))) return
    val approved = (0 until items.length()).any { index ->
      val item = items.optJSONObject(index) ?: return@any false
      item.optString("targetId") == job.targetId &&
        item.optString("identityKey") == job.identityKey && item.optString("agentId") == job.agentId
    }
    if (!approved) pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED")
  }

  fun blocksRemoval(scope: String, localId: String): Boolean {
    requireUuid(localId, "MOBILE_ATTACHMENT_INVALID")
    if (current?.let { it.scope == scope && it.localId == localId && it.state == "uploading" } == true) return true
    return index(scope).any { key ->
      val job = load(scope, key) ?: return@any true // Corrupt/unreadable journal fails closed.
      job.localId == localId && (job.state == "uploading" || job.state == "paused")
    }
  }

  fun clearRemovedSource(scope: String, localId: String) {
    check(!blocksRemoval(scope, localId)) { "MOBILE_ATTACHMENT_UPLOAD_ACTIVE" }
    val remaining = index(scope).filterNot { key ->
      val job = load(scope, key) ?: return@filterNot false
      if (job.localId == localId && job.state in setOf("ready", "cancelled")) {
        io.removeRecord(scope, key)
        true
      } else false
    }
    writeIndex(scope, remaining)
  }

  private fun scheduleStep() {
    val token = generation
    schedule {
      if (token != generation) return@schedule
      val job = current ?: return@schedule
      if (job.state != "uploading" && !(job.state == "ready" && currentStep == Step.QUERY) &&
        !(job.state == "paused" && currentStep in setOf(Step.QUERY, Step.CANCEL_STATUS, Step.CANCEL))) return@schedule
      if (!allowed()) { pause("MOBILE_ATTACHMENT_UPLOAD_PAUSED"); return@schedule }
      runStep(job, token)
    }
  }

  private fun runStep(job: Job, token: Long) {
    try {
      when (currentStep) {
        Step.STATUS, Step.QUERY, Step.CANCEL_STATUS -> {
          val queryOnly = currentStep == Step.QUERY
          val cancel = currentStep == Step.CANCEL_STATUS
          val result = rpc(job, "upload.status")
          if (isNotFound(result)) {
            if (cancel) finishCancelled(job)
            else if (queryOnly) {
              job.state = "paused"; job.assetId = null; job.errorCode = "MOBILE_UPLOAD_NOT_FOUND"
              persist(job); emit(job); current = null
            } else { currentStep = Step.BEGIN; scheduleStep() }
            return
          }
          val upload = requireUpload(result, job, allowCancelled = true)
          if (upload.state == "cancelled") { finishCancelled(job); return }
          job.receivedBytes = upload.receivedBytes
          if (queryOnly) {
            if (upload.state == "ready" && job.assetId != null) { job.state = "ready"; job.receivedBytes = job.totalBytes }
            else { job.state = "paused"; job.assetId = null }
            job.errorCode = null
            persist(job); emit(job); current = null
            return
          } else if (cancel && upload.state == "ready") {
            job.state = "uploading"
            job.errorCode = null
            currentStep = Step.FINISH
          }
          else if (cancel) currentStep = Step.CANCEL
          else if (upload.state == "ready") currentStep = Step.FINISH
          else currentStep = Step.CHUNK
          persist(job); emit(job); scheduleStep()
        }
        Step.BEGIN -> {
          val result = rpc(job, "upload.begin", JSONObject()
            .put("name", job.name).put("mimeType", job.mimeType).put("sizeBytes", job.totalBytes).put("sha256", job.sha256))
          val upload = requireUpload(result, job, allowCancelled = false)
          check(upload.state == "uploading" && upload.receivedBytes == 0L) { "MOBILE_ATTACHMENT_UPLOAD_RESPONSE_INVALID" }
          job.receivedBytes = upload.receivedBytes
          currentStep = Step.CHUNK
          persist(job); emit(job); scheduleStep()
        }
        Step.CHUNK -> {
          if (job.receivedBytes >= job.totalBytes) { currentStep = Step.FINISH; scheduleStep(); return }
          val local = io.readChunk(job.scope, job.localId, job.receivedBytes)
          checkSource(job, local.source)
          val bytes = local.bytes
          try {
            check(bytes.isNotEmpty() && bytes.size <= CHUNK_BYTES && job.receivedBytes + bytes.size <= job.totalBytes) {
              "MOBILE_ATTACHMENT_UPLOAD_SOURCE_INVALID"
            }
            val result = rpc(job, "upload.chunk", JSONObject()
              .put("offset", job.receivedBytes)
              .put("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
              .put("sha256", hash(bytes)))
            val upload = requireUpload(result, job, allowCancelled = false)
            check(upload.state != "cancelled" && upload.receivedBytes == job.receivedBytes + bytes.size) {
              "MOBILE_ATTACHMENT_UPLOAD_OFFSET_INVALID"
            }
            job.receivedBytes = upload.receivedBytes
            currentStep = if (upload.state == "ready" || job.receivedBytes == job.totalBytes) Step.FINISH else Step.CHUNK
            persist(job); emit(job); scheduleStep()
          } finally { bytes.fill(0) }
        }
        Step.FINISH -> {
          check(job.receivedBytes == job.totalBytes) { "MOBILE_ATTACHMENT_UPLOAD_RESPONSE_INVALID" }
          val result = rpc(job, "upload.finish")
          check(result.optString("kind") == "asset" && strictLong(result.opt("version")) == 1L &&
            result.optString("agentId") == job.agentId && result.optString("uploadId") == job.uploadId &&
            isCanonicalUuid(result.optString("assetId")) && result.optString("name") == job.name &&
            result.optString("mimeType") == job.mimeType && strictLong(result.opt("sizeBytes")) == job.totalBytes &&
            result.optString("sha256") == job.sha256) { "MOBILE_ATTACHMENT_UPLOAD_RESPONSE_INVALID" }
          job.assetId = result.getString("assetId")
          job.receivedBytes = job.totalBytes
          job.state = "ready"
          job.errorCode = null
          persist(job); emit(job); current = null
        }
        Step.CANCEL -> {
          val result = rpc(job, "upload.cancel")
          val upload = requireUpload(result, job, allowCancelled = true)
          check(upload.state == "cancelled") { "MOBILE_ATTACHMENT_UPLOAD_RESPONSE_INVALID" }
          finishCancelled(job)
        }
      }
    } catch (failure: Exception) {
      if (token == generation && current?.record == job.record) {
        val code = failure.message?.takeIf { it.matches(Regex("[A-Z0-9_]{1,128}")) }
          ?: "MOBILE_ATTACHMENT_UPLOAD_UNAVAILABLE"
        runCatching { pause(code) }
      }
    }
  }

  private fun finishCancelled(job: Job) {
    job.state = "cancelled"
    job.errorCode = null
    persist(job); emit(job); current = null
  }

  private data class UploadStatus(val receivedBytes: Long, val state: String)
  private fun requireUpload(value: JSONObject, job: Job, allowCancelled: Boolean): UploadStatus {
    check(value.optString("kind") == "upload" && strictLong(value.opt("version")) == 1L &&
      value.optString("agentId") == job.agentId && value.optString("uploadId") == job.uploadId &&
      strictLong(value.opt("totalBytes")) == job.totalBytes) { errorCode(value) ?: "MOBILE_ATTACHMENT_UPLOAD_RESPONSE_INVALID" }
    val received = strictLong(value.opt("receivedBytes")) ?: -1L
    val state = value.optString("state")
    check(received in 0..job.totalBytes && state in if (allowCancelled) setOf("uploading", "ready", "cancelled") else setOf("uploading", "ready")) {
      "MOBILE_ATTACHMENT_UPLOAD_RESPONSE_INVALID"
    }
    check(state != "ready" || received == job.totalBytes) { "MOBILE_ATTACHMENT_UPLOAD_RESPONSE_INVALID" }
    return UploadStatus(received, state)
  }

  private fun rpc(job: Job, kind: String, fields: JSONObject = JSONObject()): JSONObject {
    val request = JSONObject(fields.toString())
      .put("version", 1).put("kind", kind).put("agentId", job.agentId).put("uploadId", job.uploadId)
    val envelope = JSONObject().put("version", 1).put("kind", "assets")
      .put("targetId", job.targetId).put("request", request)
    val response = JSONObject(io.request(job.targetId, envelope))
    val code = errorCode(response)
    if (code != null && !(kind == "upload.status" && isNotFound(response))) throw IllegalStateException(code)
    return response
  }

  private fun isNotFound(value: JSONObject): Boolean =
    value.keys().asSequence().toSet() == setOf("kind", "version", "code") &&
      value.optString("kind") == "error" && strictLong(value.opt("version")) == 1L && value.optString("code") == "ASSET_NOT_FOUND"

  private fun errorCode(value: JSONObject): String? = value.optString("code").takeIf {
    value.optString("kind") == "error" && it.matches(Regex("[A-Z0-9_]{1,128}"))
  }

  private fun validateTarget(target: UploadTarget) {
    check(target.targetId.matches(Regex("[A-Za-z0-9._:-]{1,256}")) &&
      target.identityKey.matches(Regex("[0-9a-f]{64}")) && target.agentId.matches(Regex("[A-Za-z0-9._:-]{1,256}"))) {
      "MOBILE_TARGET_INVALID"
    }
  }

  private fun verifyBinding(job: Job, target: UploadTarget, source: UploadSource) {
    check(job.localId == source.localId && job.identityKey == target.identityKey && job.agentId == target.agentId &&
      job.name == source.name && job.mimeType == source.mimeType && job.totalBytes == source.sizeBytes && job.sha256 == source.sha256) {
      "MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED"
    }
  }
  private fun validateSource(source: UploadSource) {
    check(isCanonicalUuid(source.localId) && source.name.length in 1..256 && source.name != "." && source.name != ".." &&
      !source.name.any { it.isISOControl() || it == '/' || it == '\\' } &&
      source.mimeType.matches(Regex("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+")) &&
      source.sizeBytes in 1..MAX_BYTES && source.sha256.matches(Regex("[0-9a-f]{64}"))) {
      "MOBILE_ATTACHMENT_UPLOAD_SOURCE_INVALID"
    }
  }
  private fun checkSource(job: Job, source: UploadSource) = verifyBinding(job, UploadTarget(job.targetId, job.identityKey, job.agentId), source)

  private fun persist(job: Job) {
    val oldIndex = index(job.scope)
    val needsReservation = job.record !in oldIndex
    check(!needsReservation || oldIndex.size < MAX_JOBS) { "MOBILE_ATTACHMENT_UPLOAD_LIMIT" }
    if (needsReservation) {
      try { writeIndex(job.scope, oldIndex + job.record) }
      catch (failure: Exception) { runCatching { writeIndex(job.scope, oldIndex) }; throw failure }
    }
    val bytes = encode(job).toByteArray(Charsets.UTF_8)
    try {
      try {
        io.writeRecord(job.scope, job.record, bytes)
        val verified = io.readRecord(job.scope, job.record)
        try { check(verified?.contentEquals(bytes) == true) { "MOBILE_ATTACHMENT_UPLOAD_PERSISTENCE_UNCONFIRMED" } }
        finally { verified?.fill(0) }
      } catch (failure: Exception) {
        if (needsReservation) runCatching { io.removeRecord(job.scope, job.record); writeIndex(job.scope, oldIndex) }
        throw failure
      }
    } finally { bytes.fill(0) }
  }

  private fun load(scope: String, key: String): Job? {
    val bytes = io.readRecord(scope, key) ?: return null
    try {
      val json = JSONObject(bytes.toString(Charsets.UTF_8))
      check(json.keys().asSequence().toSet() == JOB_FIELDS) { "MOBILE_ATTACHMENT_UPLOAD_JOURNAL_INVALID" }
      check(strictLong(json.opt("version")) == 1L && strictLong(json.opt("totalBytes")) != null &&
        strictLong(json.opt("receivedBytes")) != null && json.getString("record") == key) { "MOBILE_ATTACHMENT_UPLOAD_JOURNAL_INVALID" }
      val job = Job(scope, key, json.getString("localId"), json.getString("targetId"), json.getString("identityKey"),
        json.getString("agentId"), json.getString("uploadId"), json.getString("name"), json.getString("mimeType"),
        strictLong(json.opt("totalBytes"))!!, json.getString("sha256"), strictLong(json.opt("receivedBytes"))!!, json.getString("state"),
        if (json.isNull("assetId")) null else json.getString("assetId"),
        if (json.isNull("errorCode")) null else json.getString("errorCode"))
      requireUuid(job.localId, "MOBILE_ATTACHMENT_UPLOAD_JOURNAL_INVALID")
      requireUuid(job.uploadId, "MOBILE_ATTACHMENT_UPLOAD_JOURNAL_INVALID")
      val assetId = job.assetId
      val errorCode = job.errorCode
      check(job.identityKey.matches(Regex("[0-9a-f]{64}")) && job.agentId.matches(Regex("[A-Za-z0-9._:-]{1,256}")) &&
        job.targetId.matches(Regex("[A-Za-z0-9._:-]{1,256}")) && job.sha256.matches(Regex("[0-9a-f]{64}")) &&
        job.record == recordName(job.identityKey, job.localId) &&
        job.name.length in 1..256 && job.name != "." && job.name != ".." && !job.name.any { it.isISOControl() || it == '/' || it == '\\' } &&
        job.mimeType.matches(Regex("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+")) && job.totalBytes in 1..MAX_BYTES &&
        job.receivedBytes in 0..job.totalBytes && job.state in STATES &&
        (assetId == null || isCanonicalUuid(assetId)) &&
        ((job.state == "ready") == (assetId != null)) && (job.state != "ready" || job.receivedBytes == job.totalBytes) &&
        (errorCode == null || errorCode.matches(Regex("[A-Z0-9_]{1,128}")))) {
        "MOBILE_ATTACHMENT_UPLOAD_JOURNAL_INVALID"
      }
      return job
    } finally { bytes.fill(0) }
  }

  private fun encode(job: Job): String = JSONObject()
    .put("version", 1).put("record", job.record).put("localId", job.localId).put("targetId", job.targetId)
    .put("identityKey", job.identityKey).put("agentId", job.agentId).put("uploadId", job.uploadId)
    .put("name", job.name).put("mimeType", job.mimeType).put("totalBytes", job.totalBytes)
    .put("sha256", job.sha256).put("receivedBytes", job.receivedBytes).put("state", job.state)
    .put("assetId", job.assetId ?: JSONObject.NULL).put("errorCode", job.errorCode ?: JSONObject.NULL).toString()

  private fun index(scope: String): List<String> {
    val bytes = io.readRecord(scope, INDEX_RECORD) ?: return emptyList()
    try {
      val values = JSONArray(bytes.toString(Charsets.UTF_8))
      check(values.length() <= MAX_JOBS) { "MOBILE_ATTACHMENT_UPLOAD_JOURNAL_INVALID" }
      val result = (0 until values.length()).map { values.getString(it) }
      check(result.toSet().size == result.size && result.all { it.matches(Regex("attachment-upload-v1:[0-9a-f]{64}:[0-9a-f-]{36}")) }) {
        "MOBILE_ATTACHMENT_UPLOAD_JOURNAL_INVALID"
      }
      return result
    } finally { bytes.fill(0) }
  }

  private fun ensureNoOtherActive(scope: String, record: String) {
    for (key in index(scope)) {
      if (key == record) continue
      val other = load(scope, key) ?: error("MOBILE_ATTACHMENT_UPLOAD_JOURNAL_INVALID")
      check(other.state != "uploading" && other.state != "paused") { "MOBILE_ATTACHMENT_UPLOAD_BUSY" }
    }
  }

  private fun writeIndex(scope: String, values: List<String>) {
    val bytes = JSONArray(values).toString().toByteArray(Charsets.UTF_8)
    try {
      io.writeRecord(scope, INDEX_RECORD, bytes)
      val verified = io.readRecord(scope, INDEX_RECORD)
      try { check(verified?.contentEquals(bytes) == true) { "MOBILE_ATTACHMENT_UPLOAD_PERSISTENCE_UNCONFIRMED" } }
      finally { verified?.fill(0) }
    } finally { bytes.fill(0) }
  }

  private fun projection(job: Job): JSONObject = JSONObject()
    .put("kind", "attachment-upload").put("localId", job.localId).put("targetId", job.targetId)
    .put("identityKey", job.identityKey).put("agentId", job.agentId).put("uploadId", job.uploadId)
    .put("state", job.state).put("receivedBytes", job.receivedBytes).put("totalBytes", job.totalBytes)
    .put("assetId", job.assetId ?: JSONObject.NULL).put("errorCode", job.errorCode ?: JSONObject.NULL)

  private fun emit(job: Job) = onChanged(projection(job))
  private fun recordName(identityKey: String, localId: String) = "attachment-upload-v1:$identityKey:$localId"
  private fun requireUuid(value: String, code: String) { check(isCanonicalUuid(value)) { code } }
  private fun isCanonicalUuid(value: String) = runCatching { UUID.fromString(value).toString() == value }.getOrDefault(false)
  private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
    .joinToString("") { "%02x".format(it.toInt() and 255) }

  private fun strictLong(value: Any?): Long? = when (value) {
    is Int -> value.toLong()
    is Long -> value
    else -> null
  }

  companion object {
    private const val CHUNK_BYTES = 24 * 1024
    private const val MAX_BYTES = 20L * 1024 * 1024
    private const val MAX_JOBS = 128
    private const val INDEX_RECORD = "attachment-upload-index-v1"
    private val STATES = setOf("uploading", "ready", "paused", "cancelled")
    private val JOB_FIELDS = setOf("version", "record", "localId", "targetId", "identityKey", "agentId", "uploadId", "name", "mimeType", "totalBytes", "sha256", "receivedBytes", "state", "assetId", "errorCode")
  }
}
