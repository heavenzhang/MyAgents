package com.moxbots.mobile.remote

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.UUID

internal data class ArtifactTarget(val targetId: String, val identityKey: String, val agentId: String)
internal data class ArtifactDescriptor(val artifactId: String, val name: String, val mimeType: String, val sizeBytes: Long, val sha256: String)
internal data class ReadyArtifactFile(val file: File, val name: String, val mimeType: String, val sizeBytes: Long, val sha256: String)
private fun strictArtifactLong(value: Any?): Long? = when (value) { is Int -> value.toLong(); is Long -> value; else -> null }
private fun artifactDescriptorJson(d: ArtifactDescriptor) = JSONObject().put("artifactId", d.artifactId).put("name", d.name)
  .put("mimeType", d.mimeType).put("sizeBytes", d.sizeBytes).put("sha256", d.sha256)
private fun parseArtifactDescriptor(value: JSONObject): ArtifactDescriptor {
  check(value.keys().asSequence().toSet() == setOf("artifactId", "name", "mimeType", "sizeBytes", "sha256") &&
    value.opt("artifactId") is String && value.opt("name") is String && value.opt("mimeType") is String && value.opt("sha256") is String) {
    "MOBILE_ARTIFACT_RESPONSE_INVALID"
  }
  val id = value.getString("artifactId")
  val name = value.getString("name")
  val mime = value.getString("mimeType")
  val size = strictArtifactLong(value.opt("sizeBytes")) ?: -1
  val sha = value.getString("sha256")
  check(runCatching { UUID.fromString(id).toString() == id }.getOrDefault(false) && name.length in 1..256 &&
    name.toByteArray(Charsets.UTF_8).size <= 1024 && name !in setOf(".", "..") &&
    !name.any { it.isISOControl() || it == '/' || it == '\\' } && mime.toByteArray(Charsets.UTF_8).size <= 128 &&
    mime.matches(Regex("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+")) &&
    size in 1..(20L * 1024 * 1024) && sha.matches(Regex("[0-9a-f]{64}"))) { "MOBILE_ARTIFACT_RESPONSE_INVALID" }
  return ArtifactDescriptor(id, name, mime, size, sha)
}

/** Private account-scoped disk cache plus encrypted, read-back-verified metadata. */
internal class NativeArtifactCache(private val context: android.content.Context, private val records: SecureRecords, private val scope: String,
  private val fault: (String) -> Unit = {}) {
  private val scopeHash = MessageDigest.getInstance("SHA-256").digest(scope.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
  private val root = File(File(context.noBackupFilesDir, "artifacts-v1"), scopeHash)
  private val legacyRoot = File(File(context.filesDir, "artifacts-v1"), scopeHash)
  private val indexName = "artifact-cache-index-v1"
  init { check(root.isDirectory || root.mkdirs()) { "MOBILE_ARTIFACT_CACHE_UNAVAILABLE" }; android.system.Os.chmod(root.absolutePath, 448) }

  private fun record(identity: String, session: String, id: String) = "artifact-v1:$identity:$session:$id"
  private fun catalog(identity: String, session: String) = "artifact-catalog-v1:$identity:$session"
  fun saveCatalog(identity: String, session: String, agent: String, before: String?, next: String?, items: List<ArtifactDescriptor>) {
    val key = catalog(identity, session)
    val existing = if (before == null) null else records.read(scope, key)?.let { bytes ->
      try { JSONObject(bytes.toString(Charsets.UTF_8)) } finally { bytes.fill(0) }
    }
    if (before != null) check(existing != null && existing.keys().asSequence().toSet() == setOf("version", "identityKey", "agentId", "sessionId", "nextBefore", "items") &&
      strictArtifactLong(existing.opt("version")) == 1L && existing.optString("identityKey") == identity && existing.optString("sessionId") == session && existing.optString("agentId") == agent &&
      existing.opt("nextBefore").let { if (it === JSONObject.NULL) null else it as? String } == before) { "MOBILE_ARTIFACT_REFRESH_REQUIRED" }
    val all = LinkedHashMap<String, ArtifactDescriptor>()
    if (existing != null) {
      val old = existing.optJSONArray("items") ?: error("MOBILE_ARTIFACT_CACHE_INVALID")
      for (i in 0 until old.length()) { val d = parseArtifactDescriptor(old.getJSONObject(i)); all[d.artifactId] = d }
    }
    for (d in items) {
      val old = all[d.artifactId]
      check(old == null || old == d) { "MOBILE_ARTIFACT_DESCRIPTOR_CHANGED" }
      all[d.artifactId] = d
    }
    check(all.size <= 128) { "MOBILE_ARTIFACT_CACHE_LIMIT" }
    val value = JSONObject().put("version", 1).put("identityKey", identity).put("agentId", agent)
      .put("sessionId", session).put("nextBefore", next ?: JSONObject.NULL)
      .put("items", JSONArray(all.values.map(::artifactDescriptorJson)))
    val bytes = value.toString().toByteArray(Charsets.UTF_8)
    try {
      check(bytes.size <= 220 * 1024) { "MOBILE_ARTIFACT_CACHE_LIMIT" }
      records.write(scope, key, bytes)
      val check = records.read(scope, key)
      try { require(check?.contentEquals(bytes) == true) { "MOBILE_ARTIFACT_PERSISTENCE_UNCONFIRMED" } }
      finally { check?.fill(0) }
    } finally { bytes.fill(0) }
  }
  fun requireListed(identity: String, session: String, agent: String, descriptor: ArtifactDescriptor) {
    val bytes = records.read(scope, catalog(identity, session)) ?: error("MOBILE_ARTIFACT_REFRESH_REQUIRED")
    try {
      val value = JSONObject(bytes.toString(Charsets.UTF_8))
      check(value.optInt("version") == 1 && value.optString("identityKey") == identity &&
        value.optString("agentId") == agent && value.optString("sessionId") == session) { "MOBILE_ARTIFACT_REFRESH_REQUIRED" }
      val items = value.optJSONArray("items") ?: error("MOBILE_ARTIFACT_CACHE_INVALID")
      val found = (0 until items.length()).map { parseArtifactDescriptor(items.getJSONObject(it)) }.firstOrNull { it.artifactId == descriptor.artifactId }
      check(found != null) { "MOBILE_ARTIFACT_REFRESH_REQUIRED" }
      check(found == descriptor) { "MOBILE_ARTIFACT_DESCRIPTOR_CHANGED" }
    } finally { bytes.fill(0) }
  }
  private fun file(identity: String, session: String, id: String): File {
    val key = "$scope\u0000$identity\u0000$session\u0000$id".toByteArray(Charsets.UTF_8)
    val hash = MessageDigest.getInstance("SHA-256").digest(key).joinToString("") { "%02x".format(it.toInt() and 255) }
    val target = File(root, hash)
    val legacy = File(legacyRoot, hash)
    if (legacy.isFile) {
      if (target.exists()) check(target.delete()) { "MOBILE_ARTIFACT_CACHE_UNAVAILABLE" }
      if (!legacy.renameTo(target)) {
        legacy.copyTo(target, overwrite = true)
        check(target.length() == legacy.length() && legacy.delete()) { "MOBILE_ARTIFACT_CACHE_UNAVAILABLE" }
      }
      android.system.Os.chmod(target.absolutePath, 384)
    }
    return target
  }
  private fun index(scope: String): MutableList<String> {
    val bytes = records.read(scope, indexName) ?: return mutableListOf()
    try {
      val arr = JSONArray(bytes.toString(Charsets.UTF_8))
      check(arr.length() <= 256) { "MOBILE_ARTIFACT_CACHE_INVALID" }
      val values = (0 until arr.length()).map { arr.getString(it) }
      check(values.toSet().size == values.size && values.all { it.matches(Regex("artifact-v1:[0-9a-f]{64}:[A-Za-z0-9-]{1,99}:[0-9a-f-]{36}")) }) { "MOBILE_ARTIFACT_CACHE_INVALID" }
      val recovered = mutableListOf<String>()
      var changed = false
      values.forEach { entry ->
        val parts = entry.split(":")
        val job = read(scope, parts[1], parts[2], parts[3])
        if (job == null) {
          val orphan = file(parts[1], parts[2], parts[3])
          check(!orphan.exists() || orphan.delete()) { "MOBILE_ARTIFACT_CACHE_UNAVAILABLE" }
          changed = true // A process may have stopped after reserving the index but before its sealed job.
        } else if (job.optString("state") == "deleting") {
          val file = file(parts[1], parts[2], parts[3])
          check(!file.exists() || file.delete()) { "MOBILE_ARTIFACT_CACHE_UNAVAILABLE" }
          records.remove(scope, entry)
          changed = true
        } else recovered += entry // Keep sealed paused, active, and ready jobs reachable.
      }
      if (changed) saveIndex(scope, recovered)
      return recovered
    } finally { bytes.fill(0) }
  }
  private fun saveIndex(scope: String, values: List<String>) {
    val bytes = JSONArray(values).toString().toByteArray(Charsets.UTF_8)
    try {
      records.write(scope, indexName, bytes)
      val check = records.read(scope, indexName)
      try { require(check?.contentEquals(bytes) == true) { "MOBILE_ARTIFACT_PERSISTENCE_UNCONFIRMED" } }
      finally { check?.fill(0) }
    } finally { bytes.fill(0) }
  }
  fun read(scope: String, identity: String, session: String, id: String): JSONObject? {
    val key = record(identity, session, id)
    val bytes = records.read(scope, key) ?: return null
    try {
      val job = JSONObject(bytes.toString(Charsets.UTF_8))
      check(job.keys().asSequence().toSet() == FIELDS && job.getInt("version") == 1 &&
        job.getString("record") == key && job.getString("identityKey") == identity &&
        job.getString("sessionId") == session && job.getString("artifactId") == id) { "MOBILE_ARTIFACT_CACHE_INVALID" }
      return job
    } finally { bytes.fill(0) }
  }
  fun reserve(scope: String, identity: String, session: String, descriptor: ArtifactDescriptor, agentId: String): JSONObject {
    val key = record(identity, session, descriptor.artifactId)
    val entries = index(scope)
    val existing = read(scope, identity, session, descriptor.artifactId)
    if (existing != null) {
      check(existing.getString("name") == descriptor.name && existing.getString("mimeType") == descriptor.mimeType &&
        existing.getLong("sizeBytes") == descriptor.sizeBytes && existing.getString("sha256") == descriptor.sha256 &&
        existing.getString("agentId") == agentId) { "MOBILE_ARTIFACT_DESCRIPTOR_CHANGED" }
      if (key !in entries) saveIndex(scope, entries + key)
      return existing
    }
    val targetCount = entries.count { it.startsWith("artifact-v1:$identity:") }
    check(targetCount < 10 && entries.size < 256) { "MOBILE_ARTIFACT_CACHE_LIMIT" }
    val used = entries.sumOf { entry ->
      val parts = entry.split(":")
      if (parts.size != 4) error("MOBILE_ARTIFACT_CACHE_INVALID")
      val old = read(scope, parts[1], parts[2], parts[3]) ?: error("MOBILE_ARTIFACT_CACHE_INVALID")
      old.getLong("sizeBytes")
    }
    check(used + descriptor.sizeBytes <= 200L * 1024 * 1024) { "MOBILE_ARTIFACT_CACHE_LIMIT" }
    val job = JSONObject().put("version", 1).put("record", key).put("identityKey", identity).put("agentId", agentId)
      .put("sessionId", session).put("artifactId", descriptor.artifactId).put("name", descriptor.name)
      .put("mimeType", descriptor.mimeType).put("sizeBytes", descriptor.sizeBytes).put("sha256", descriptor.sha256)
      .put("receivedBytes", 0).put("state", "paused").put("errorCode", JSONObject.NULL)
    // Reserve the index first; only a confirmed metadata record can authorize an assets.read.
    saveIndex(scope, entries + key)
    fault("reserve.index")
    write(scope, job)
    fault("reserve.job")
    return job
  }
  fun recover(scope: String) { index(scope) }
  fun write(scope: String, job: JSONObject) {
    val bytes = job.toString().toByteArray(Charsets.UTF_8)
    try {
      records.write(scope, job.getString("record"), bytes)
      val verified = records.read(scope, job.getString("record"))
      try { require(verified?.contentEquals(bytes) == true) { "MOBILE_ARTIFACT_PERSISTENCE_UNCONFIRMED" } }
      finally { verified?.fill(0) }
    } finally { bytes.fill(0) }
  }
  fun append(identity: String, session: String, id: String, expected: Long, bytes: ByteArray) {
    val file = file(identity, session, id)
    RandomAccessFile(file, "rw").use { out ->
      check(out.length() == expected) { "MOBILE_ARTIFACT_CACHE_INVALID" }
      out.seek(expected); out.write(bytes); out.fd.sync()
    }
    android.system.Os.chmod(file.absolutePath, 384)
  }
  fun length(identity: String, session: String, id: String) = file(identity, session, id).length()
  fun reconcile(identity: String, session: String, id: String, committed: Long) {
    val file = file(identity, session, id)
    check(!file.exists() || file.length() >= committed) { "MOBILE_ARTIFACT_CACHE_INVALID" }
    if (file.exists() && file.length() > committed) RandomAccessFile(file, "rw").use { it.setLength(committed); it.fd.sync() }
  }
  fun hash(identity: String, session: String, id: String): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file(identity, session, id).inputStream().use { input ->
      val buffer = ByteArray(24 * 1024)
      try { while (true) { val n = input.read(buffer); if (n < 0) break; if (n > 0) digest.update(buffer, 0, n) } }
      finally { buffer.fill(0) }
    }
    return digest.digest().hex()
  }
  fun delete(scope: String, identity: String, session: String, id: String) {
    val key = record(identity, session, id)
    val entries = index(scope)
    val job = read(scope, identity, session, id)
    check(key in entries || job != null) { "MOBILE_ARTIFACT_NOT_FOUND" }
    if (key !in entries && job != null) saveIndex(scope, entries + key)
    if (job != null) {
      job.put("state", "deleting")
      write(scope, job)
      fault("delete.marker")
    }
    val f = file(identity, session, id)
    check(!f.exists() || f.delete()) { "MOBILE_ARTIFACT_CACHE_UNAVAILABLE" }
    fault("delete.file")
    records.remove(scope, key)
    fault("delete.record")
    saveIndex(scope, entries.filterNot { it == key })
    fault("delete.index")
  }
  fun localFile(identity: String, session: String, id: String) = file(identity, session, id)
  companion object { private val FIELDS = setOf("version", "record", "identityKey", "agentId", "sessionId", "artifactId", "name", "mimeType", "sizeBytes", "sha256", "receivedBytes", "state", "errorCode") }
}

/** Owner-queue downloader: one existing assets.read RPC per owner turn. */
internal class NativeArtifactScheduler(
  private val cache: NativeArtifactCache,
  private val scope: String,
  private val schedule: (() -> Unit) -> Unit,
  private val request: (String, JSONObject) -> JSONObject,
  private val allowed: () -> Boolean,
  private val onChanged: (JSONObject) -> Unit,
) {
  private var current: JSONObject? = null
  private var currentTarget: ArtifactTarget? = null
  private var generation = 0L
  private var cursor: String? = null

  fun list(target: ArtifactTarget, sessionId: String, limit: Int, before: String?): JSONObject {
    validateTarget(target); validateSession(sessionId)
    require(limit in 1..30 && (before == null || before.isNotEmpty() && before.toByteArray().size <= 256)) { "MOBILE_INTENT_INVALID" }
    val result = request(target.targetId, JSONObject().put("version", 1).put("kind", "list").put("agentId", target.agentId)
      .put("sessionId", sessionId).put("limit", limit).apply { if (before != null) put("before", before) })
    throwRemoteError(result)
    val rawNextBefore = result.opt("nextBefore")
    check(result.keys().asSequence().toSet() == setOf("version", "kind", "agentId", "sessionId", "items", "hasMore", "nextBefore") &&
      result.opt("kind") is String && result.opt("agentId") is String && result.opt("sessionId") is String &&
      (rawNextBefore === JSONObject.NULL || rawNextBefore is String) &&
      strictLong(result.opt("version")) == 1L && result.optString("kind") == "list" && result.optString("agentId") == target.agentId &&
      result.optString("sessionId") == sessionId && result.opt("hasMore") is Boolean &&
      result.getBoolean("hasMore") == !result.isNull("nextBefore")
    ) { "MOBILE_ARTIFACT_RESPONSE_INVALID" }
    val items = result.optJSONArray("items") ?: error("MOBILE_ARTIFACT_RESPONSE_INVALID")
    check(items.length() <= limit) { "MOBILE_ARTIFACT_RESPONSE_INVALID" }
    val projected = JSONArray()
    val seen = mutableSetOf<String>()
    for (index in 0 until items.length()) {
      val raw = items.optJSONObject(index) ?: error("MOBILE_ARTIFACT_RESPONSE_INVALID")
      val descriptor = parseDescriptor(raw)
      check(seen.add(descriptor.artifactId)) { "MOBILE_ARTIFACT_RESPONSE_INVALID" }
      projected.put(descriptorJson(descriptor))
    }
    val next = if (result.isNull("nextBefore")) null else result.optString("nextBefore")
    check(next == null || next.isNotEmpty() && next.toByteArray().size <= 256 && next != before) { "MOBILE_ARTIFACT_RESPONSE_INVALID" }
    cache.saveCatalog(target.identityKey, sessionId, target.agentId, before, next,
      (0 until items.length()).map { parseDescriptor(items.getJSONObject(it)) })
    return JSONObject().put("kind", "artifact-list").put("targetId", target.targetId).put("identityKey", target.identityKey)
      .put("agentId", target.agentId).put("sessionId", sessionId).put("items", projected)
      .put("hasMore", result.getBoolean("hasMore")).put("nextBefore", next ?: JSONObject.NULL)
  }

  fun download(target: ArtifactTarget, session: String, descriptor: ArtifactDescriptor): JSONObject {
    validateTarget(target); validateSession(session); validateDescriptor(descriptor)
    cache.requireListed(target.identityKey, session, target.agentId, descriptor)
    current?.let { active -> check(active.optString("state") != "downloading") { "MOBILE_ARTIFACT_BUSY" } }
    val job = cache.reserve(scope, target.identityKey, session, descriptor, target.agentId)
    cache.reconcile(target.identityKey, session, descriptor.artifactId, job.getLong("receivedBytes"))
    check(job.optLong("receivedBytes", -1) == cache.length(target.identityKey, session, descriptor.artifactId)) {
      "MOBILE_ARTIFACT_CACHE_INVALID"
    }
    currentTarget = target
    current = job
    generation++
    job.put("state", "downloading").put("errorCode", JSONObject.NULL)
    persist(job)
    emit(job, target)
    scheduleStep()
    return projection(job, target)
  }

  fun status(target: ArtifactTarget, session: String, id: String): JSONObject {
    cache.recover(scope)
    validateTarget(target); validateSession(session); validateUuid(id)
    val job = cache.read(scope, target.identityKey, session, id) ?: error("MOBILE_ARTIFACT_NOT_FOUND")
    check(job.getString("agentId") == target.agentId) { "MOBILE_ARTIFACT_SCOPE_CHANGED" }
    val length = cache.length(target.identityKey, session, id)
    check(length == job.getLong("receivedBytes")) { "MOBILE_ARTIFACT_CACHE_INVALID" }
    if (job.getString("state") == "ready") check(length == job.getLong("sizeBytes") && cache.hash(target.identityKey, session, id) == job.getString("sha256")) { "MOBILE_ARTIFACT_CACHE_INVALID" }
    val projection = projection(job, target)
    if (job.getString("state") == "downloading" && current?.getString("record") != job.getString("record")) {
      projection.put("state", "paused")
    }
    return projection
  }

  fun pause(target: ArtifactTarget, session: String, id: String): JSONObject {
    val job = localJob(target, session, id)
    if (current?.getString("record") == job.getString("record")) {
      generation++
      current = null; currentTarget = null
    }
    if (job.getString("state") != "ready") job.put("state", "paused")
    job.put("errorCode", JSONObject.NULL); persist(job); emit(job, target)
    return projection(job, target)
  }

  fun remove(target: ArtifactTarget, session: String, id: String): JSONObject {
    val job = localJob(target, session, id)
    check(current?.getString("record") != job.getString("record")) { "MOBILE_ARTIFACT_ACTIVE" }
    cache.delete(scope, target.identityKey, session, id)
    return JSONObject().put("kind", "artifact-action").put("action", "remove").put("targetId", target.targetId)
      .put("identityKey", target.identityKey).put("agentId", target.agentId).put("sessionId", session)
      .put("artifactId", id).put("state", "removed").put("errorCode", JSONObject.NULL)
  }

  fun readyFile(target: ArtifactTarget, session: String, id: String): ReadyArtifactFile {
    val job = localJob(target, session, id)
    check(job.getString("state") == "ready" && job.getLong("receivedBytes") == job.getLong("sizeBytes") &&
      cache.length(target.identityKey, session, id) == job.getLong("sizeBytes") && cache.hash(target.identityKey, session, id) == job.getString("sha256")) {
      "MOBILE_ARTIFACT_NOT_READY"
    }
    return ReadyArtifactFile(cache.localFile(target.identityKey, session, id), job.getString("name"), job.getString("mimeType"),
      job.getLong("sizeBytes"), job.getString("sha256"))
  }

  fun pause() {
    val job = current ?: return
    generation++
    val target = currentTarget
    if (job.optString("state") == "downloading") { job.put("state", "paused"); job.put("errorCode", "MOBILE_ARTIFACT_PAUSED"); persist(job); if (target != null) emit(job, target) }
    current = null; currentTarget = null
  }

  fun pauseForTarget(targetId: String) {
    if (currentTarget?.targetId?.let { it != targetId } == true) pause()
  }
  fun pauseForSession(sessionId: String) { if (current?.optString("sessionId") == sessionId) pause() }
  fun validateTargets(items: JSONArray) {
    val target = currentTarget ?: return
    val approved = (0 until items.length()).any { index ->
      val item = items.optJSONObject(index) ?: return@any false
      item.optString("targetId") == target.targetId && item.optString("identityKey") == target.identityKey &&
        item.optString("agentId") == target.agentId
    }
    if (!approved) pause()
  }

  private fun localJob(target: ArtifactTarget, session: String, id: String): JSONObject {
    cache.recover(scope)
    validateTarget(target); validateSession(session); validateUuid(id)
    val job = cache.read(scope, target.identityKey, session, id) ?: error("MOBILE_ARTIFACT_NOT_FOUND")
    check(job.optString("agentId") == target.agentId) { "MOBILE_ARTIFACT_SCOPE_CHANGED" }
    return job
  }
  private fun scheduleStep() {
    val token = generation
    schedule {
      if (token != generation) return@schedule
      val job = current ?: return@schedule
      val target = currentTarget ?: return@schedule
      if (!allowed()) { pause(); return@schedule }
      try {
        check(job.optString("state") == "downloading") { "MOBILE_ARTIFACT_PAUSED" }
        val offset = job.getLong("receivedBytes")
        val response = request(target.targetId, JSONObject().put("version", 1).put("kind", "read").put("agentId", target.agentId)
          .put("sessionId", job.getString("sessionId")).put("artifactId", job.getString("artifactId"))
          .put("offset", offset).put("maxBytes", CHUNK_BYTES))
        if (token != generation || current?.getString("record") != job.getString("record")) return@schedule
        throwRemoteError(response)
        check(response.opt("eof") is Boolean) { "MOBILE_ARTIFACT_RESPONSE_INVALID" }
        val bytes = parseChunk(response, job, offset)
        try {
          val next = offset + bytes.size
          check(next <= job.getLong("sizeBytes") && (response.getBoolean("eof") == (next == job.getLong("sizeBytes")))) {
            "MOBILE_ARTIFACT_RESPONSE_INVALID"
          }
          cache.append(target.identityKey, job.getString("sessionId"), job.getString("artifactId"), offset, bytes)
          job.put("receivedBytes", next)
          val done = response.getBoolean("eof")
          val completionTarget = target
          if (done) {
            check(next == job.getLong("sizeBytes") && cache.hash(target.identityKey, job.getString("sessionId"), job.getString("artifactId")) == job.getString("sha256")) {
              "MOBILE_ARTIFACT_HASH_MISMATCH"
            }
            job.put("state", "ready")
          }
          persist(job); emit(job, completionTarget)
          if (done) { current = null; currentTarget = null }
        } finally { bytes.fill(0) }
        if (job.optString("state") == "downloading") scheduleStep()
      } catch (failure: Exception) {
        if (token == generation && current?.getString("record") == job.getString("record")) {
          generation++
          job.put("state", "paused").put("errorCode", code(failure))
          val failureTarget = target
          persist(job); emit(job, failureTarget); current = null; currentTarget = null
        }
      }
    }
  }
  private fun parseChunk(value: JSONObject, job: JSONObject, offset: Long): ByteArray {
    check(value.keys().asSequence().toSet() == setOf("version", "kind", "agentId", "sessionId", "artifactId", "offset", "dataBase64", "sha256", "eof") &&
      value.opt("kind") is String && value.opt("agentId") is String && value.opt("sessionId") is String &&
      value.opt("artifactId") is String && value.opt("dataBase64") is String && value.opt("sha256") is String &&
      strictLong(value.opt("version")) == 1L && value.optString("kind") == "chunk" && value.optString("agentId") == job.getString("agentId") &&
      value.optString("sessionId") == job.getString("sessionId") && value.optString("artifactId") == job.getString("artifactId") &&
      strictLong(value.opt("offset")) == offset && value.optString("sha256").matches(Regex("[0-9a-f]{64}"))) { "MOBILE_ARTIFACT_RESPONSE_INVALID" }
    val encoded = value.getString("dataBase64")
    check(encoded.length <= 32768 && encoded.length % 4 == 0 && encoded.matches(Regex("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?"))) { "MOBILE_ARTIFACT_RESPONSE_INVALID" }
    val bytes = Base64.decode(encoded, Base64.DEFAULT)
    check(bytes.size <= CHUNK_BYTES && (bytes.isNotEmpty() || value.opt("eof") == true) &&
      Base64.encodeToString(bytes, Base64.NO_WRAP) == encoded && bytes.sha256() == value.getString("sha256")) {
      bytes.fill(0); "MOBILE_ARTIFACT_HASH_MISMATCH"
    }
    return bytes
  }
  private fun persist(job: JSONObject) {
    cache.write(scope, job)
  }
  private fun emit(job: JSONObject, target: ArtifactTarget) { onChanged(projection(job, target)) }
  private fun projection(job: JSONObject, target: ArtifactTarget) = JSONObject()
    .put("kind", "artifact-download").put("targetId", target.targetId).put("identityKey", job.getString("identityKey"))
    .put("agentId", job.getString("agentId")).put("sessionId", job.getString("sessionId"))
    .put("artifactId", job.getString("artifactId")).put("name", job.getString("name")).put("mimeType", job.getString("mimeType"))
    .put("sha256", job.getString("sha256")).put("state", job.getString("state")).put("receivedBytes", job.getLong("receivedBytes"))
    .put("totalBytes", job.getLong("sizeBytes")).put("errorCode", job.opt("errorCode") ?: JSONObject.NULL)
  private fun validateTarget(t: ArtifactTarget) { check(t.targetId.matches(Regex("[A-Za-z0-9._:-]{1,256}")) && t.identityKey.matches(Regex("[0-9a-f]{64}")) && t.agentId.matches(Regex("[A-Za-z0-9._:-]{1,256}"))) { "MOBILE_TARGET_INVALID" } }
  private fun validateDescriptor(d: ArtifactDescriptor) { check(isUuid(d.artifactId) && d.name.length in 1..256 && d.name.toByteArray(Charsets.UTF_8).size <= 1024 && d.name !in setOf(".", "..") && !d.name.any { it.isISOControl() || it == '/' || it == '\\' } && d.mimeType.toByteArray(Charsets.UTF_8).size <= 128 && d.mimeType.matches(Regex("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+")) && d.sizeBytes in 1..MAX_BYTES && d.sha256.matches(Regex("[0-9a-f]{64}"))) { "MOBILE_INTENT_INVALID" } }
  private fun parseDescriptor(d: JSONObject): ArtifactDescriptor {
    check(d.keys().asSequence().toSet() == setOf("artifactId", "name", "mimeType", "sizeBytes", "sha256") &&
      d.opt("artifactId") is String && d.opt("name") is String && d.opt("mimeType") is String && d.opt("sha256") is String) { "MOBILE_ARTIFACT_RESPONSE_INVALID" }
    val result = ArtifactDescriptor(d.optString("artifactId"), d.optString("name"), d.optString("mimeType"), strictLong(d.opt("sizeBytes")) ?: -1, d.optString("sha256"))
    validateDescriptor(result); return result
  }
  private fun descriptorJson(d: ArtifactDescriptor) = JSONObject().put("artifactId", d.artifactId).put("name", d.name).put("mimeType", d.mimeType).put("sizeBytes", d.sizeBytes).put("sha256", d.sha256)
  private fun validateSession(s: String) { check(s.matches(Regex("[A-Za-z0-9-]{1,99}"))) { "MOBILE_INTENT_INVALID" } }
  private fun validateUuid(s: String) { check(isUuid(s)) { "MOBILE_INTENT_INVALID" } }
  private fun isUuid(s: String) = runCatching { UUID.fromString(s).toString() == s }.getOrDefault(false)
  private fun strictLong(v: Any?): Long? = when (v) { is Int -> v.toLong(); is Long -> v; else -> null }
  private fun code(e: Exception) = e.message?.takeIf { it.matches(Regex("[A-Z0-9_]{1,128}")) } ?: "MOBILE_ARTIFACT_UNAVAILABLE"
  private fun throwRemoteError(value: JSONObject) {
    if (value.opt("kind") == "error") {
      val code = value.opt("code") as? String
      val keys = value.keys().asSequence().toSet()
      val typedAsset = keys == setOf("version", "kind", "code") && strictLong(value.opt("version")) == 1L &&
        code?.matches(Regex("ASSET_[A-Z0-9_]{1,122}")) == true
      val connectionFailure = keys == setOf("kind", "code") && code?.matches(Regex("[A-Z0-9_]{1,128}")) == true
      check(typedAsset || connectionFailure) { "MOBILE_ARTIFACT_RESPONSE_INVALID" }
      error(requireNotNull(code))
    }
  }
  companion object { private const val CHUNK_BYTES = 24 * 1024; private const val MAX_BYTES = 20L * 1024 * 1024 }
}

private fun ByteArray.sha256() = MessageDigest.getInstance("SHA-256").digest(this).hex()
private fun ByteArray.hex() = joinToString("") { "%02x".format(it.toInt() and 255) }
