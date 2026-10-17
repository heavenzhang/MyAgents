import { z } from 'zod';
export const REMOTE_MOBILE_BYTES = 48 * 1024;
const agentId = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
const sessionId = z.string().min(1).max(99).regex(/^[A-Za-z0-9-]+$/);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const label = z.string().min(1).max(256).refine(v => !/\p{Cc}/u.test(v));
const revision = z.string().max(128);
const code = z.string().min(1).max(128).regex(/^[A-Z0-9_]+$/);
const base = {version: z.literal(1), agentId};
const mutation = {...base, operationId: uuid, text: z.string().max(16000), assetIds: z.array(uuid).max(8).refine(v => new Set(v).size === v.length), modelId: label.optional()};
function bounded(value: unknown) {return new TextEncoder().encode(JSON.stringify(value)).length <= REMOTE_MOBILE_BYTES;}
export const remoteMobileRequestSchema = z.discriminatedUnion('kind', [
 z.object({...base,kind:z.literal('mobile.capabilities')}).strict(),
 z.object({...base,kind:z.literal('mobile.models')}).strict(),
 z.object({...base,kind:z.literal('mobile.suggestions'),sessionId,revision}).strict(),
 z.object({...mutation,kind:z.literal('mobile.start')}).strict().refine(v => v.text.length > 0 || v.assetIds.length > 0),
 z.object({...mutation,kind:z.literal('mobile.send'),sessionId}).strict().refine(v => v.text.length > 0 || v.assetIds.length > 0),
 z.object({...base,kind:z.literal('mobile.receipt'),operationId:uuid}).strict(),
]).refine(bounded);
export const remoteMobileResultSchema = z.discriminatedUnion('kind', [
 z.object({...base,kind:z.literal('mobile.capabilities'),attachments:z.literal(true),modelSelection:z.literal(true),nextSuggestions:z.literal(true),maxAssets:z.literal(8)}).strict(),
 z.object({...base,kind:z.literal('mobile.models'),items:z.array(z.object({id:label,label}).strict()).max(30).refine(v => new Set(v.map(m => m.id)).size === v.length)}).strict(),
 z.object({...base,kind:z.literal('mobile.suggestions'),sessionId,revision,suggestions:z.array(z.string().min(1).max(512)).max(3)}).strict(),
 z.object({...base,kind:z.literal('mobile.receipt'),operationId:uuid,sessionId:sessionId.nullable(),status:z.enum(['processing','accepted','rejected','unconfirmed','not-found']),code:code.nullable()}).strict(),
 z.object({version:z.literal(1),kind:z.literal('mobile.error'),code}).strict(),
]).refine(bounded);
export type RemoteMobileRequest = z.infer<typeof remoteMobileRequestSchema>;
export type RemoteMobileResult = z.infer<typeof remoteMobileResultSchema>;
