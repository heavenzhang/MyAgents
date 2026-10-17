import { z } from 'zod';

// App-local closed codec mirrors src/shared/remoteMobile.ts. The shared codec
// is Node-owned and not importable from the Expo Metro package boundary.
const maxBytes = 48 * 1024;
const agentId = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
const sessionId = z.string().min(1).max(99).regex(/^[A-Za-z0-9-]+$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const label = z.string().min(1).max(256).refine((value) => !/\p{Cc}/u.test(value));
const code = z.string().min(1).max(128).regex(/^[A-Z0-9_]+$/);
const base = { version: z.literal(1), agentId };
const mutation = { ...base, operationId: uuid, text: z.string().max(16000), assetIds: z.array(uuid).max(8).refine((values) => new Set(values).size === values.length), modelId: label.optional() };
function bounded<T extends z.ZodTypeAny>(schema: T) {
  return schema.refine((value) => new TextEncoder().encode(JSON.stringify(value)).length <= maxBytes);
}

export const remoteMobileRequestSchema = bounded(z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('mobile.capabilities') }).strict(),
  z.object({ ...base, kind: z.literal('mobile.models') }).strict(),
  z.object({ ...base, kind: z.literal('mobile.suggestions'), sessionId, revision: z.string().max(128) }).strict(),
  z.object({ ...mutation, kind: z.literal('mobile.start') }).strict().refine((value) => value.text.length > 0 || value.assetIds.length > 0),
  z.object({ ...mutation, kind: z.literal('mobile.send'), sessionId }).strict().refine((value) => value.text.length > 0 || value.assetIds.length > 0),
  z.object({ ...base, kind: z.literal('mobile.receipt'), operationId: uuid }).strict(),
]));
export const remoteMobileResultSchema = bounded(z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('mobile.capabilities'), attachments: z.literal(true), modelSelection: z.literal(true), nextSuggestions: z.literal(true), maxAssets: z.literal(8) }).strict(),
  z.object({ ...base, kind: z.literal('mobile.models'), items: z.array(z.object({ id: label, label }).strict()).max(30).refine((values) => new Set(values.map((item) => item.id)).size === values.length) }).strict(),
  z.object({ ...base, kind: z.literal('mobile.suggestions'), sessionId, revision: z.string().max(128), suggestions: z.array(z.string().min(1).max(512)).max(3) }).strict(),
  z.object({ ...base, kind: z.literal('mobile.receipt'), operationId: uuid, sessionId: sessionId.nullable(), status: z.enum(['processing', 'accepted', 'rejected', 'unconfirmed', 'not-found']), code: code.nullable() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('mobile.error'), code }).strict(),
]));

const bridgeErrorSchema = z.object({ kind: z.literal('error'), code: z.string().min(1).max(128).regex(/^[A-Z0-9_]+$/) }).strict();

export function parseMobileBridgeResult(value: unknown): RemoteMobileResult {
  const bridgeError = bridgeErrorSchema.safeParse(value);
  if (bridgeError.success) throw new Error(bridgeError.data.code);
  const result = remoteMobileResultSchema.safeParse(value);
  if (!result.success) throw new Error('MOBILE_REPLY_INVALID');
  return result.data;
}

export type RemoteMobileRequest = z.infer<typeof remoteMobileRequestSchema>;
export type RemoteMobileResult = z.infer<typeof remoteMobileResultSchema>;
