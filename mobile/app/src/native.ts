import { requireNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';
import { z } from 'zod';
import { parseMobileBridgeResult, remoteMobileRequestSchema, type RemoteMobileRequest, type RemoteMobileResult } from './mobileProtocol';
export type { RemoteMobileRequest } from './mobileProtocol';

const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
const sessionId = z.string().min(1).max(99).regex(/^[A-Za-z0-9-]+$/);
const message = z.object({ id, role: z.enum(['user', 'assistant']), timestamp: z.string().max(64), content: z.string().max(16000), truncated: z.boolean(), tools: z.array(z.object({ id, name: z.string().max(160), status: z.enum(['running', 'complete', 'error']), summary: z.string().max(2000) }).strict()).max(10) }).strict();
const interaction = z.object({ requestId: id, generation: id, turnId: id, interaction: z.enum(['permission', 'plan', 'question']), title: z.string().max(256), description: z.string().max(4000), actionable: z.boolean(), questions: z.array(z.object({ answerKey: z.string().max(512), question: z.string().max(512), options: z.array(z.string().max(256)).max(8), multiSelect: z.boolean() }).strict()).max(6) }).strict();
const sessionResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('capabilities'), version: z.literal(1), agentId: id, runtime: z.string().max(64), maxActiveSessions: z.number().int().min(1).max(100), liveUpdates: z.literal('snapshot') }).strict(),
  z.object({ kind: z.literal('list'), agentId: id, items: z.array(z.object({ sessionId, title: z.string().max(256), updatedAt: z.string().max(64), preview: z.string().max(512), runtime: z.string().max(64) }).strict()).max(30), hasMore: z.boolean(), nextBefore: z.string().max(256).nullable() }).strict(),
  z.object({ kind: z.literal('snapshot'), agentId: id, sessionId, generation: id.nullable(), turnId: id.nullable(), revision: z.string().max(128), state: z.enum(['idle', 'running', 'waiting_user_action', 'unavailable']), title: z.string().max(256), runtime: z.string().max(64), model: z.string().max(256).nullable(), terminal: z.enum(['complete', 'stopped', 'error', 'interrupted']).nullable(), messages: z.array(message).max(30), interactions: z.array(interaction).max(8), hasMoreBefore: z.boolean(), nextBefore: z.string().max(256).nullable() }).strict(),
  z.object({ kind: z.literal('receipt'), agentId: id, operationId: z.string().uuid(), sessionId: sessionId.nullable(), status: z.enum(['processing', 'accepted', 'rejected', 'unconfirmed', 'not-found']), code: z.string().regex(/^[A-Z0-9_]+$/).max(128).nullable() }).strict(),
  z.object({ kind: z.literal('error'), code: z.string().regex(/^[A-Z0-9_]+$/).max(128) }).strict(),
]);
const speechReply = z.object({ kind: z.literal('speech'), state: z.enum(['recording', 'transcribing', 'idle']), text: z.string().max(8000), final: z.boolean(), code: z.string().regex(/^[A-Z0-9_]+$/).max(128).optional() }).strict();
const attachment = z.object({ kind: z.literal('attachment'), localId: z.string().uuid(), name: z.string().min(1).max(256), mimeType: z.string().min(1).max(128), sizeBytes: z.number().int().positive().max(20 * 1024 * 1024), sha256: z.string().regex(/^[0-9a-f]{64}$/), image: z.boolean() }).strict();
const attachmentUpload = z.object({ kind: z.literal('attachment-upload'), localId: z.string().uuid(), targetId: z.string().min(1), identityKey: z.string().min(1).max(256), agentId: id, uploadId: z.string().uuid(), state: z.enum(['uploading', 'ready', 'paused', 'cancelled']), receivedBytes: z.number().int().min(0).max(20 * 1024 * 1024), totalBytes: z.number().int().positive().max(20 * 1024 * 1024), assetId: z.string().uuid().nullable(), errorCode: z.string().regex(/^[A-Z0-9_]+$/).max(128).nullable() }).strict().refine((value) => value.receivedBytes <= value.totalBytes && (value.state !== 'ready' || value.assetId !== null));
const attachments = z.object({ kind: z.literal('attachments'), items: z.array(attachment).max(8) }).strict();
const attachmentRemoved = z.object({ kind: z.literal('attachment-removed'), localId: z.string().uuid() }).strict();
const artifactDescriptor = z.object({ artifactId: z.string().uuid(), name: z.string().min(1).max(256), mimeType: z.string().min(1).max(128), sizeBytes: z.number().int().positive().max(20 * 1024 * 1024), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const artifactDownload = z.object({ kind: z.literal('artifact-download'), targetId: z.string().min(1).max(256), identityKey: z.string().min(1).max(256), agentId: id, sessionId, artifactId: z.string().uuid(), name: z.string().min(1).max(256), mimeType: z.string().min(1).max(128), sha256: z.string().regex(/^[0-9a-f]{64}$/), state: z.enum(['downloading', 'ready', 'paused']), receivedBytes: z.number().int().min(0).max(20 * 1024 * 1024), totalBytes: z.number().int().positive().max(20 * 1024 * 1024), errorCode: z.string().regex(/^[A-Z0-9_]{1,128}$/).nullable() }).strict().refine((value) => value.receivedBytes <= value.totalBytes && (value.state !== 'ready' || value.receivedBytes === value.totalBytes));
const artifactListReply = z.object({ kind: z.literal('artifact-list'), targetId: z.string().min(1).max(256), identityKey: z.string().min(1).max(256), agentId: id, sessionId, items: z.array(artifactDescriptor).max(30), hasMore: z.boolean(), nextBefore: z.string().max(256).nullable() }).strict().refine((value) => value.hasMore === (value.nextBefore !== null));
const artifactAction = z.object({ kind: z.literal('artifact-action'), action: z.enum(['remove', 'preview', 'share']), targetId: z.string().min(1).max(256), identityKey: z.string().min(1).max(256), agentId: id, sessionId, artifactId: z.string().uuid(), state: z.enum(['removed', 'presented']), errorCode: z.string().regex(/^[A-Z0-9_]{1,128}$/).nullable() }).strict().refine((value) => (value.action === 'remove') === (value.state === 'removed'));

export type Account = { kind: 'account'; state: 'signed-out' | 'authenticating' | 'signed-in' | 'expired'; displayName: string | null; principalId: string | null };
export type Target = { targetId: string; identityKey: string; agentId: string; name: string; deviceName: string; online: boolean; runtime: string | null };
export type DraftReply = { kind: 'draft'; identityKey: string; agentId: string; sessionId: string | null; text: string; revision: number; lastWriteId: string | null };
export type NativeAttachment = z.infer<typeof attachment>;
export type NativeAttachmentUpload = z.infer<typeof attachmentUpload>;
export type ArtifactDescriptor = z.infer<typeof artifactDescriptor>;
export type ArtifactDownload = z.infer<typeof artifactDownload>;
export type ArtifactListReply = z.infer<typeof artifactListReply>;
export type ArtifactActionReply = z.infer<typeof artifactAction>;
export type SessionRequest =
  | { kind: 'capabilities'; agentId: string }
  | { kind: 'list'; agentId: string; limit: number; before?: string }
  | { kind: 'get'; agentId: string; sessionId: string; limit: number; before?: string }
  | { kind: 'start'; agentId: string; operationId: string; text: string }
  | { kind: 'send'; agentId: string; sessionId: string; operationId: string; text: string }
  | { kind: 'receipt'; agentId: string; operationId: string }
  | { kind: 'respond'; agentId: string; sessionId: string; operationId: string; generation: string; turnId: string; requestId: string; interaction: 'permission' | 'plan' | 'question'; approved: boolean; answers?: Record<string, string> }
  | { kind: 'stop'; agentId: string; sessionId: string; operationId: string; generation: string; turnId: string };
export type SessionResult = z.infer<typeof sessionResult>;
export type SpeechReply = z.infer<typeof speechReply>;
export type Snapshot = Extract<SessionResult, { kind: 'snapshot' }>;
export type Interaction = Snapshot['interactions'][number];
export type PendingOperation = { protocol: 'session' | 'mobile'; targetId: string; agentId: string; operationId: string; sessionId: string | null; status: 'prepared' | 'unknown' | 'processing' };

export type NativeIntent =
  | { version: 1; kind: 'account.status' | 'account.login.poll' | 'account.logout' }
  | { version: 1; kind: 'account.login.start' }
  | { version: 1; kind: 'targets.list' }
  | { version: 1; kind: 'operations.pending' }
  | { version: 1; kind: 'draft.read'; targetId: string; sessionId: string | null }
  | { version: 1; kind: 'draft.write'; targetId: string; sessionId: string | null; expectedRevision: number; writeId: string; text: string }
  | { version: 1; kind: 'attachment.pick'; source: 'file' | 'image' }
  | { version: 1; kind: 'attachment.list' }
  | { version: 1; kind: 'attachment.remove'; localId: string }
  | { version: 1; kind: 'attachment.upload' | 'attachment.upload.status' | 'attachment.upload.pause' | 'attachment.upload.cancel'; localId: string; targetId: string }
  | { version: 1; kind: 'artifact.list'; targetId: string; sessionId: string; limit: number; before?: string }
  | { version: 1; kind: 'artifact.download'; targetId: string; sessionId: string; artifact: ArtifactDescriptor }
  | { version: 1; kind: 'artifact.status' | 'artifact.pause' | 'artifact.remove' | 'artifact.preview' | 'artifact.share'; targetId: string; sessionId: string; artifactId: string }
  | { version: 1; kind: 'mobile'; targetId: string; request: RemoteMobileRequest }
  | { version: 1; kind: 'speech.start' | 'speech.stop' | 'speech.cancel' }
  | { version: 1; kind: 'session'; targetId: string; request: SessionRequest };

const accountSchema = z.object({ kind: z.literal('account'), state: z.enum(['signed-out', 'authenticating', 'signed-in', 'expired']), displayName: z.string().nullable(), principalId: z.string().nullable() }).strict();
const targetSchema = z.object({ targetId: z.string().min(1), identityKey: z.string().min(1).max(256), agentId: id, name: z.string(), deviceName: z.string(), online: z.boolean(), runtime: z.string().nullable() }).strict();
const draftReadIntent = z.object({ version: z.literal(1), kind: z.literal('draft.read'), targetId: z.string().min(1), sessionId: sessionId.nullable() }).strict();
const draftWriteIntent = z.object({ version: z.literal(1), kind: z.literal('draft.write'), targetId: z.string().min(1), sessionId: sessionId.nullable(), expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), writeId: z.string().uuid(), text: z.string().max(16000) }).strict();
const draftReply = z.object({ kind: z.literal('draft'), identityKey: z.string().min(1).max(256), agentId: id, sessionId: sessionId.nullable(), text: z.string().max(16000), revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), lastWriteId: z.string().uuid().nullable() }).strict();
const attachmentIntentSchema = z.discriminatedUnion('kind', [z.object({ version: z.literal(1), kind: z.literal('attachment.pick'), source: z.enum(['file', 'image']) }).strict(), z.object({ version: z.literal(1), kind: z.literal('attachment.list') }).strict(), z.object({ version: z.literal(1), kind: z.literal('attachment.remove'), localId: z.string().uuid() }).strict(), z.object({ version: z.literal(1), kind: z.enum(['attachment.upload', 'attachment.upload.status', 'attachment.upload.pause', 'attachment.upload.cancel']), localId: z.string().uuid(), targetId: z.string().min(1) }).strict()]);
const artifactIntentSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('artifact.list'), targetId: z.string().min(1).max(256), sessionId, limit: z.number().int().min(1).max(30), before: z.string().min(1).max(256).optional() }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('artifact.download'), targetId: z.string().min(1).max(256), sessionId, artifact: artifactDescriptor }).strict(),
  z.object({ version: z.literal(1), kind: z.enum(['artifact.status', 'artifact.pause', 'artifact.remove', 'artifact.preview', 'artifact.share']), targetId: z.string().min(1).max(256), sessionId, artifactId: z.string().uuid() }).strict(),
]);
const pendingSchema = z.object({ kind: z.literal('operations'), items: z.array(z.object({ protocol: z.enum(['session', 'mobile']), targetId: z.string(), agentId: id, operationId: z.string().uuid(), sessionId: sessionId.nullable(), status: z.enum(['prepared', 'unknown', 'processing']) }).strict()) }).strict();
const nativeReply = z.union([accountSchema, z.object({ kind: z.literal('login'), authorizationUrl: z.string().url(), expiresAt: z.number() }).strict(), z.object({ kind: z.literal('targets'), items: z.array(targetSchema).max(100), hasMore: z.boolean() }).strict(), pendingSchema, draftReply, attachment, attachments, attachmentRemoved, attachmentUpload, artifactListReply, artifactDownload, artifactAction, sessionResult, speechReply, z.object({ kind: z.literal('error'), code: z.string().regex(/^[A-Z0-9_]+$/).max(128) }).strict()]);

type RemoteBridge = { request(intentJSON: string): Promise<string>; addListener(event: 'speechChanged', listener: (payload: SpeechReply) => void): { remove(): void }; addListener(event: 'attachmentUploadChanged', listener: (payload: NativeAttachmentUpload) => void): { remove(): void }; addListener(event: 'artifactDownloadChanged', listener: (payload: ArtifactDownload) => void): { remove(): void } };
function getRemoteBridge(): RemoteBridge {
  return requireNativeModule<RemoteBridge>('MoxBotsRemote');
}

function moduleRequest(intent: NativeIntent): Promise<unknown> {
  try {
    const bridge = getRemoteBridge();
    return bridge.request(JSON.stringify(intent)).then((raw) => JSON.parse(raw));
  } catch (error) {
    return Promise.reject(error);
  }
}

export function subscribeSpeechChanges(listener: (payload: SpeechReply) => void): () => void {
  if (isFixtureMode) return () => undefined;
  const subscription = getRemoteBridge().addListener('speechChanged', listener);
  return () => subscription.remove();
}

export function subscribeAttachmentUploadChanges(listener: (payload: NativeAttachmentUpload) => void): () => void {
  if (isFixtureMode) return () => undefined;
  const subscription = getRemoteBridge().addListener('attachmentUploadChanged', (payload) => {
    const parsed = attachmentUpload.safeParse(payload);
    if (parsed.success) listener(parsed.data);
  });
  return () => subscription.remove();
}

export function subscribeArtifactDownloadChanges(listener: (payload: ArtifactDownload) => void): () => void {
  if (isFixtureMode) {
    let active = true;
    let unsubscribe: () => void = () => {};
    void import('../qa/fixture').then((fixture) => {
      if (active) unsubscribe = fixture.subscribeArtifactDownloadChanges(listener);
    });
    return () => { active = false; unsubscribe(); };
  }
  const subscription = getRemoteBridge().addListener('artifactDownloadChanged', (payload) => {
    const parsed = artifactDownload.safeParse(payload);
    if (parsed.success) listener(parsed.data);
  });
  return () => subscription.remove();
}

export async function requestMobile(targetId: string, request: RemoteMobileRequest): Promise<RemoteMobileResult> {
  const checkedRequest = remoteMobileRequestSchema.safeParse(request);
  if (!checkedRequest.success) throw new Error('MOBILE_INTENT_INVALID');
  const intent: NativeIntent = { version: 1, kind: 'mobile', targetId, request: checkedRequest.data };
  const raw = isFixtureMode ? (await import('../qa/fixture')).fixtureReply(intent) : await moduleRequest(intent);
  const result = parseMobileBridgeResult(raw);
  if (result.kind !== 'mobile.error' && result.agentId !== request.agentId) throw new Error('MOBILE_RESPONSE_SCOPE_MISMATCH');
  if (result.kind === 'mobile.receipt' && request.kind === 'mobile.send' && result.sessionId !== request.sessionId) throw new Error('MOBILE_RECEIPT_SCOPE_MISMATCH');
  return result;
}

export async function requestNative(intent: NativeIntent): Promise<z.infer<typeof nativeReply>> {
  if (intent.kind === 'mobile') throw new Error('MOBILE_INTENT_REQUIRES_REQUEST_MOBILE');
  if (isFixtureMode) {
    const { fixtureReply } = await import('../qa/fixture');
    const parsedFixture = nativeReply.safeParse(fixtureReply(intent));
    if (!parsedFixture.success) throw new Error('QA_FIXTURE_REPLY_INVALID');
    return parsedFixture.data;
  }
  const checkedIntent = intent.kind === 'draft.read' ? draftReadIntent.safeParse(intent)
    : intent.kind === 'draft.write' ? draftWriteIntent.safeParse(intent)
      : intent.kind.startsWith('attachment.') ? attachmentIntentSchema.safeParse(intent)
      : intent.kind.startsWith('artifact.') ? artifactIntentSchema.safeParse(intent)
      : null;
  if (checkedIntent && !checkedIntent.success) throw new Error('NATIVE_INTENT_INVALID');
  const parsed = nativeReply.safeParse(await moduleRequest(checkedIntent?.success ? checkedIntent.data as NativeIntent : intent));
  if (!parsed.success) throw new Error('NATIVE_REPLY_INVALID');
  return parsed.data;
}

export const isFixtureMode = __DEV__ && Platform.OS === 'web' && process.env.EXPO_PUBLIC_MOBILE_QA === '1';

export type QaScenario = 'conversation' | 'multi-bot' | 'offline' | 'approval' | 'stale-approval' | 'unknown-receipt' | 'reset-unknown' | 'network-error' | 'draft-error' | 'mobile-unsupported' | 'mobile-error';
export const qaScenarioOptions: readonly { id: QaScenario; label: string }[] = [
  { id: 'conversation', label: '会话' }, { id: 'multi-bot', label: '多 Bot / 离线' },
  { id: 'offline', label: '全部离线' }, { id: 'approval', label: '审批 / 拒绝' },
  { id: 'stale-approval', label: '过期审批' }, { id: 'unknown-receipt', label: '回执未知' },
  { id: 'reset-unknown', label: '重启后未确认' },
  { id: 'network-error', label: '网络错误' }, { id: 'draft-error', label: '草稿保存失败' },
  { id: 'mobile-unsupported', label: '移动协议不支持' }, { id: 'mobile-error', label: '移动协议网络错误' },
];

export async function selectQaScenario(scenario: QaScenario): Promise<void> {
  if (!isFixtureMode) return;
  const fixture = await import('../qa/fixture');
  fixture.selectScenario(scenario);
}

export async function armQaStaleApproval(): Promise<void> {
  if (!isFixtureMode) return;
  const fixture = await import('../qa/fixture');
  fixture.armStaleApproval();
}

export type QaArtifactScenario = 'normal' | 'error' | 'late-event';
export const qaArtifactScenarioOptions: readonly { id: QaArtifactScenario; label: string }[] = [
  { id: 'normal', label: '正常下载' }, { id: 'error', label: '下载错误' }, { id: 'late-event', label: '事件先于回执' },
];
export async function selectQaArtifactScenario(scenario: QaArtifactScenario): Promise<void> {
  if (!isFixtureMode) return;
  const fixture = await import('../qa/fixture');
  fixture.selectArtifactScenario(scenario);
}

export function parseSessionReply(reply: z.infer<typeof nativeReply>): SessionResult {
  const parsed = sessionResult.safeParse(reply);
  if (!parsed.success) throw new Error('SESSION_REPLY_INVALID');
  return parsed.data;
}
