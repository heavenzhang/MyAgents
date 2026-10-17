import { z } from 'zod';
export const REMOTE_ASSET_MAX_BYTES = 20 * 1024 * 1024;
export const REMOTE_ASSET_CHUNK_BYTES = 24 * 1024;
const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const session = z.string().min(1).max(99).regex(/^[A-Za-z0-9-]+$/);
const label = z.string().min(1).max(256).refine(s => s !== '.' && s !== '..' && !/[\p{Cc}/\\]/u.test(s));
const mime = z.string().max(128).regex(/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const size = z.number().int().min(1).max(REMOTE_ASSET_MAX_BYTES);
const offset = z.number().int().min(0).max(REMOTE_ASSET_MAX_BYTES);
const cursor = z.string().min(1).max(256).refine(s => new TextEncoder().encode(s).length <= 256);
function decodedLength(s: string): number | null {
  if (s.length > 32768 || s.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) return null;
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  if (pad) { const n = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(s[s.length - pad - 1]); if ((pad === 2 && (n & 15) !== 0) || (pad === 1 && (n & 3) !== 0)) return null; }
  return s.length / 4 * 3 - pad;
}
const chunk = z.string().refine(s => { const n = decodedLength(s); return n !== null && n > 0 && n <= REMOTE_ASSET_CHUNK_BYTES; });
const base = { version: z.literal(1), agentId: id };
const upload = { ...base, uploadId: uuid };
export const remoteAssetRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('capabilities') }).strict(),
  z.object({ ...upload, kind: z.literal('upload.begin'), name: label, mimeType: mime, sizeBytes: size, sha256: hash }).strict(),
  z.object({ ...upload, kind: z.literal('upload.chunk'), offset: offset.refine(n => n < REMOTE_ASSET_MAX_BYTES), dataBase64: chunk, sha256: hash }).strict(),
  z.object({ ...upload, kind: z.literal('upload.status') }).strict(),
  z.object({ ...upload, kind: z.literal('upload.finish') }).strict(),
  z.object({ ...upload, kind: z.literal('upload.cancel') }).strict(),
  z.object({ ...base, kind: z.literal('list'), sessionId: session, limit: z.number().int().min(1).max(30), before: cursor.optional() }).strict(),
  z.object({ ...base, kind: z.literal('read'), sessionId: session, artifactId: uuid, offset, maxBytes: z.number().int().min(1).max(REMOTE_ASSET_CHUNK_BYTES) }).strict(),
]);
export const remoteArtifactDescriptorSchema = z.object({ artifactId: uuid, name: label, mimeType: mime, sizeBytes: size, sha256: hash }).strict();
const resultBase = { version: z.literal(1) };
export const remoteAssetResultSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('capabilities'), maxBytes: z.literal(REMOTE_ASSET_MAX_BYTES), maxChunkBytes: z.literal(REMOTE_ASSET_CHUNK_BYTES) }).strict(),
  z.object({ ...upload, kind: z.literal('upload'), receivedBytes: offset, totalBytes: size, state: z.enum(['uploading', 'ready', 'cancelled']) }).strict().refine(v => v.receivedBytes <= v.totalBytes),
  z.object({ ...upload, kind: z.literal('asset'), assetId: uuid, name: label, mimeType: mime, sizeBytes: size, sha256: hash }).strict(),
  z.object({ ...base, kind: z.literal('list'), sessionId: session, items: z.array(remoteArtifactDescriptorSchema).max(30), hasMore: z.boolean(), nextBefore: cursor.nullable() }).strict().refine(v => v.hasMore === (v.nextBefore !== null)),
  z.object({ ...base, kind: z.literal('chunk'), sessionId: session, artifactId: uuid, offset, dataBase64: z.string(), sha256: hash, eof: z.boolean() }).strict().refine(v => { const n = decodedLength(v.dataBase64); return n !== null && n <= REMOTE_ASSET_CHUNK_BYTES && (n > 0 || v.eof) && v.offset + n <= REMOTE_ASSET_MAX_BYTES; }),
  z.object({ ...resultBase, kind: z.literal('error'), code: z.string().min(1).max(128).regex(/^[A-Z0-9_]+$/) }).strict(),
]);
export type RemoteAssetRequest = z.infer<typeof remoteAssetRequestSchema>;
export type RemoteAssetResult = z.infer<typeof remoteAssetResultSchema>;
