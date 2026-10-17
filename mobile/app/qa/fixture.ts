import type { Account, ArtifactDownload, ArtifactDescriptor, NativeIntent, PendingOperation, SessionRequest, Snapshot, Target } from '../src/native';

export type QaScenario = 'conversation' | 'multi-bot' | 'offline' | 'approval' | 'stale-approval' | 'unknown-receipt' | 'reset-unknown' | 'network-error' | 'draft-error' | 'mobile-unsupported' | 'mobile-error';

const target: Target = { targetId: 'qa-target-internal-only', identityKey: 'qa-identity-main', agentId: 'qa-agent', name: '演示 Bot', deviceName: '本地演示设备', online: true, runtime: null };
const offlineTarget: Target = { targetId: 'qa-offline-target', identityKey: 'qa-identity-offline', agentId: 'qa-offline-agent', name: '离线 Bot', deviceName: '离线演示设备', online: false, runtime: null };
const account: Account = { kind: 'account', state: 'signed-in', displayName: '演示账号', principalId: 'qa-principal' };
let fixtureAccount: Account = account;
let scenario: QaScenario = 'conversation';
let active: Snapshot | null = null;
let staleApprovalNextRead = false;
let sessions: { sessionId: string; title: string; updatedAt: string; preview: string; runtime: string }[] = [{ sessionId: 'qa-session-1', title: '产品方案讨论', updatedAt: new Date().toISOString(), preview: '梳理移动端的会话体验', runtime: 'codex' }];

export function selectScenario(next: QaScenario): void {
  scenario = next;
  active = null;
  staleApprovalNextRead = false;
  fixtureAccount = account;
}

export function armStaleApproval(): void {
  staleApprovalNextRead = true;
}

export function fixtureReply(intent: NativeIntent): unknown {
  if (intent.kind === 'account.status' || intent.kind === 'account.login.poll') return fixtureAccount;
  if (intent.kind === 'account.logout') { fixtureAccount = { kind: 'account', state: 'signed-out', displayName: null, principalId: null }; return fixtureAccount; }
  if (intent.kind === 'account.login.start') return { kind: 'login', authorizationUrl: 'https://example.invalid/qa-only', expiresAt: 0 };
  if (intent.kind === 'targets.list') {
    if (scenario === 'network-error') return { kind: 'error', code: 'MOBILE_REMOTE_UNAVAILABLE' };
    return { kind: 'targets', items: scenario === 'multi-bot' ? [target, offlineTarget] : scenario === 'offline' ? [offlineTarget] : [target], hasMore: false };
  }
  if (intent.kind === 'operations.pending') return { kind: 'operations', items: scenario === 'reset-unknown' ? [
    { protocol: 'session', targetId: target.targetId, agentId: target.agentId, operationId: '00000000-0000-4000-8000-000000000042', sessionId: 'qa-session-1', status: 'unknown' },
    { protocol: 'mobile', targetId: target.targetId, agentId: target.agentId, operationId: '00000000-0000-4000-8000-000000000043', sessionId: null, status: 'unknown' },
  ] : [] as PendingOperation[] };
  if (intent.kind === 'mobile') return mobileReply(intent.targetId, intent.request);
  if (intent.kind === 'attachment.pick' || intent.kind === 'attachment.list' || intent.kind === 'attachment.remove' || intent.kind === 'attachment.upload' || intent.kind === 'attachment.upload.status' || intent.kind === 'attachment.upload.pause' || intent.kind === 'attachment.upload.cancel') return attachmentReply(intent);
  if (intent.kind === 'draft.read' || intent.kind === 'draft.write') return fixtureDraftReply(intent);
  if (intent.kind === 'artifact.list' || intent.kind === 'artifact.download' || intent.kind === 'artifact.status' || intent.kind === 'artifact.pause' || intent.kind === 'artifact.remove' || intent.kind === 'artifact.preview' || intent.kind === 'artifact.share') return fixtureArtifactReply(intent);
  if (intent.kind === 'session' && intent.request) return sessionReply(intent.request);
  return { kind: 'error', code: 'QA_FIXTURE_OPERATION_UNSUPPORTED' };
}

export type FixtureArtifactScenario = 'normal' | 'error' | 'late-event';
let artifactScenario: FixtureArtifactScenario = 'normal';
const artifactDescriptors: ArtifactDescriptor[] = [
  { artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', name: '移动端体验方案.pdf', mimeType: 'application/pdf', sizeBytes: 84000, sha256: 'a'.repeat(64) },
  { artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', name: '界面示意图.png', mimeType: 'image/png', sizeBytes: 42000, sha256: 'b'.repeat(64) },
];
const artifactDownloads = new Map<string, ArtifactDownload>();
const artifactListeners = new Set<(value: ArtifactDownload) => void>();
export function selectArtifactScenario(next: FixtureArtifactScenario): void {
  artifactScenario = next;
  artifactDownloads.clear();
}
export function subscribeArtifactDownloadChanges(listener: (value: ArtifactDownload) => void): () => void {
  artifactListeners.add(listener);
  return () => artifactListeners.delete(listener);
}
function emitArtifactDownload(value: ArtifactDownload): void {
  for (const listener of artifactListeners) listener(value);
}
function fixtureArtifactReply(intent: Extract<NativeIntent, { kind: `artifact.${string}` }>): unknown {
  const approved = [target, offlineTarget].find((item) => item.targetId === intent.targetId);
  if (!approved) return { kind: 'error', code: 'MOBILE_TARGET_INVALID' };
  if (intent.kind === 'artifact.list') {
    const secondPage = intent.before === 'qa-artifact-page-2';
    const items = secondPage ? [artifactDescriptors[1]] : [artifactDescriptors[0]];
    return { kind: 'artifact-list', targetId: approved.targetId, identityKey: approved.identityKey, agentId: approved.agentId,
      sessionId: intent.sessionId, items, hasMore: !secondPage, nextBefore: secondPage ? null : 'qa-artifact-page-2' };
  }
  const descriptor = intent.kind === 'artifact.download' ? intent.artifact : artifactDescriptors.find((item) => item.artifactId === intent.artifactId);
  if (!descriptor) return { kind: 'error', code: 'MOBILE_ARTIFACT_NOT_FOUND' };
  const key = `${approved.targetId}:${intent.sessionId}:${descriptor.artifactId}`;
  const job = artifactDownloads.get(key);
  const actionReply = (action: 'remove' | 'preview' | 'share', state: 'removed' | 'presented') => ({ kind: 'artifact-action', action,
    targetId: approved.targetId, identityKey: approved.identityKey, agentId: approved.agentId, sessionId: intent.sessionId,
    artifactId: descriptor.artifactId, state, errorCode: null });
  if (intent.kind === 'artifact.status') return job ?? { kind: 'error', code: 'MOBILE_ARTIFACT_NOT_FOUND' };
  if (intent.kind === 'artifact.pause') {
    if (!job) return { kind: 'error', code: 'MOBILE_ARTIFACT_NOT_FOUND' };
    const paused = { ...job, state: job.state === 'ready' ? 'ready' as const : 'paused' as const, errorCode: null };
    artifactDownloads.set(key, paused); emitArtifactDownload(paused); return paused;
  }
  if (intent.kind === 'artifact.remove') {
    if (!job) return { kind: 'error', code: 'MOBILE_ARTIFACT_NOT_FOUND' };
    if (job.state === 'downloading') return { kind: 'error', code: 'MOBILE_ARTIFACT_ACTIVE' };
    artifactDownloads.delete(key); return actionReply('remove', 'removed');
  }
  if (intent.kind === 'artifact.preview' || intent.kind === 'artifact.share') {
    if (job?.state !== 'ready') return { kind: 'error', code: 'MOBILE_ARTIFACT_NOT_READY' };
    return actionReply(intent.kind === 'artifact.preview' ? 'preview' : 'share', 'presented');
  }
  if (artifactScenario === 'error') return { kind: 'error', code: 'MOBILE_REMOTE_UNAVAILABLE' };
  const base: ArtifactDownload = { kind: 'artifact-download', targetId: approved.targetId, identityKey: approved.identityKey,
    agentId: approved.agentId, sessionId: intent.sessionId, artifactId: descriptor.artifactId, name: descriptor.name,
    mimeType: descriptor.mimeType, sha256: descriptor.sha256, state: 'downloading', receivedBytes: 0,
    totalBytes: descriptor.sizeBytes, errorCode: null };
  artifactDownloads.set(key, base);
  const progress = { ...base, receivedBytes: Math.floor(descriptor.sizeBytes / 2) };
  const ready = { ...base, state: 'ready' as const, receivedBytes: descriptor.sizeBytes };
  if (artifactScenario === 'late-event') {
    setTimeout(() => { artifactDownloads.set(key, ready); emitArtifactDownload(ready); }, 20);
    return new Promise((resolve) => setTimeout(() => resolve(base), 120));
  }
  setTimeout(() => { artifactDownloads.set(key, progress); emitArtifactDownload(progress); }, 80);
  setTimeout(() => { artifactDownloads.set(key, ready); emitArtifactDownload(ready); }, 220);
  return base;
}

let fixtureAttachmentNumber = 0;
const fixtureAttachments = new Map<string, { localId: string; name: string; mimeType: string; sizeBytes: number; sha256: string; image: boolean }>();
const fixtureUploads = new Map<string, { targetId: string; identityKey: string; agentId: string; uploadId: string; state: 'uploading' | 'ready' | 'paused' | 'cancelled'; receivedBytes: number; totalBytes: number; assetId: string | null; errorCode: string | null }>();
function attachmentReply(intent: Extract<NativeIntent, { kind: `attachment.${string}` }>): unknown {
  if (intent.kind === 'attachment.pick') {
    const localId = `10000000-0000-4000-8000-${String(++fixtureAttachmentNumber).padStart(12, '0')}`;
    const picked = { kind: 'attachment', localId, name: intent.source === 'image' ? '演示图片.png' : '演示文件.txt', mimeType: intent.source === 'image' ? 'image/png' : 'text/plain', sizeBytes: 1200, sha256: '0'.repeat(64), image: intent.source === 'image' };
    fixtureAttachments.set(localId, picked);
    return picked;
  }
  if (intent.kind === 'attachment.list') return { kind: 'attachments', items: [...fixtureAttachments.values()] };
  if (intent.kind === 'attachment.remove') {
    if (fixtureUploads.get(intent.localId)?.state === 'uploading') return { kind: 'error', code: 'MOBILE_ATTACHMENT_UPLOAD_ACTIVE' };
    fixtureAttachments.delete(intent.localId); fixtureUploads.delete(intent.localId);
    return { kind: 'attachment-removed', localId: intent.localId };
  }
  const picked = fixtureAttachments.get(intent.localId);
  const approved = [target, offlineTarget].find((entry) => entry.targetId === intent.targetId);
  if (!picked || !approved) return { kind: 'error', code: 'MOBILE_ATTACHMENT_NOT_FOUND' };
  const prior = fixtureUploads.get(intent.localId);
  if (intent.kind === 'attachment.upload.status') return prior ? { kind: 'attachment-upload', localId: intent.localId, ...prior } : { kind: 'error', code: 'MOBILE_UPLOAD_NOT_FOUND' };
  if (intent.kind === 'attachment.upload.cancel') {
    if (!prior) return { kind: 'error', code: 'MOBILE_UPLOAD_NOT_FOUND' };
    const cancelled = { ...prior, state: 'cancelled' as const, assetId: null };
    fixtureUploads.set(intent.localId, cancelled);
    return { kind: 'attachment-upload', localId: intent.localId, ...cancelled };
  }
  if (intent.kind === 'attachment.upload.pause') {
    if (!prior) return { kind: 'error', code: 'MOBILE_UPLOAD_NOT_FOUND' };
    const paused = { ...prior, state: prior.state === 'ready' ? 'ready' as const : 'paused' as const };
    fixtureUploads.set(intent.localId, paused);
    return { kind: 'attachment-upload', localId: intent.localId, ...paused };
  }
  if (scenario === 'mobile-error') return { kind: 'error', code: 'MOBILE_REMOTE_UNAVAILABLE' };
  if (prior?.state === 'cancelled') return { kind: 'error', code: 'MOBILE_UPLOAD_CANCELLED' };
  const ready = { targetId: intent.targetId, identityKey: approved.identityKey, agentId: approved.agentId, uploadId: prior?.uploadId ?? `20000000-0000-4000-8000-${String(fixtureAttachmentNumber).padStart(12, '0')}`, state: 'ready' as const, receivedBytes: picked.sizeBytes, totalBytes: picked.sizeBytes, assetId: `30000000-0000-4000-8000-${String(fixtureAttachmentNumber).padStart(12, '0')}`, errorCode: null };
  fixtureUploads.set(intent.localId, ready);
  return { kind: 'attachment-upload', localId: intent.localId, ...ready };
}

function mobileReply(targetId: string, request: Extract<NativeIntent, { kind: 'mobile' }>['request']): unknown {
  if (scenario === 'mobile-error') return { version: 1, kind: 'mobile.error', code: 'MOBILE_REMOTE_UNAVAILABLE' };
  if (scenario === 'mobile-unsupported') return { version: 1, kind: 'mobile.error', code: 'MOBILE_PROFILE_MISMATCH' };
  const approved = [target, offlineTarget].find((entry) => entry.targetId === targetId);
  if (!approved) return { version: 1, kind: 'mobile.error', code: 'TARGET_UNAVAILABLE' };
  if (request.kind === 'mobile.capabilities') return { version: 1, kind: 'mobile.capabilities', agentId: request.agentId, attachments: true, modelSelection: true, nextSuggestions: true, maxAssets: 8 };
  if (request.kind === 'mobile.models') return { version: 1, kind: 'mobile.models', agentId: request.agentId, items: [{ id: 'qa-model-fast', label: '演示模型 · 快速' }, { id: 'qa-model-reasoning', label: '演示模型 · 深度' }] };
  if (request.kind === 'mobile.suggestions') return { version: 1, kind: 'mobile.suggestions', agentId: request.agentId, sessionId: request.sessionId, revision: request.revision, suggestions: ['列出当前方案中的关键假设', '按优先级整理下一步', '补充一段简短摘要'] };
  if (request.kind === 'mobile.receipt') return { version: 1, kind: 'mobile.receipt', agentId: request.agentId, operationId: request.operationId, sessionId: active?.sessionId ?? null, status: 'not-found', code: null };
  if (scenario === 'unknown-receipt') return { version: 1, kind: 'mobile.receipt', agentId: request.agentId, operationId: request.operationId, sessionId: request.kind === 'mobile.send' ? request.sessionId : null, status: 'unconfirmed', code: 'MOBILE_RECEIPT_REQUIRED' };
  const sessionId = request.kind === 'mobile.start' ? `qa-mobile-session-${sessions.length + 1}` : request.sessionId;
  const now = new Date().toISOString();
  const added = [
    { id: `qa-mobile-user-${Date.now()}`, role: 'user' as const, timestamp: now, content: request.text || '已添加附件', truncated: false, tools: [] },
    { id: `qa-mobile-reply-${Date.now()}`, role: 'assistant' as const, timestamp: now, content: '已收到演示内容。此反馈仅用于浏览器 QA，不代表设备端实际执行。', truncated: false, tools: [] },
  ];
  active = { ...makeSnapshot(sessionId, request.agentId), revision: String(Date.now()), terminal: 'complete', messages: [...(request.kind === 'mobile.send' ? active?.messages ?? [] : []), ...added].slice(-30) };
  if (request.kind === 'mobile.start') sessions = [{ sessionId, title: (request.text || '附件会话').slice(0, 48), updatedAt: now, preview: request.text || '已添加附件', runtime: 'codex' }, ...sessions].slice(0, 30);
  return { version: 1, kind: 'mobile.receipt', agentId: request.agentId, operationId: request.operationId, sessionId, status: 'accepted', code: null };
}

type FixtureDraft = { identityKey: string; agentId: string; sessionId: string | null; text: string; revision: number; lastWriteId: string | null };
const fixtureDraftStorageKey = 'moxbots-mobile-qa-fixture-drafts';
let draftsLoaded = false;
let fixtureDrafts = new Map<string, FixtureDraft>();
function getFixtureDrafts(): Map<string, FixtureDraft> {
  if (draftsLoaded) return fixtureDrafts;
  draftsLoaded = true;
  try {
    const stored: unknown = typeof localStorage === 'undefined' ? null : JSON.parse(localStorage.getItem(fixtureDraftStorageKey) ?? 'null');
    if (Array.isArray(stored)) fixtureDrafts = new Map(stored.filter((entry): entry is FixtureDraft => !!entry && typeof entry === 'object' && typeof entry.identityKey === 'string' && typeof entry.agentId === 'string' && typeof entry.text === 'string' && typeof entry.revision === 'number').map((entry) => [JSON.stringify([entry.identityKey, entry.sessionId]), entry]));
  } catch { fixtureDrafts = new Map(); }
  return fixtureDrafts;
}
function fixtureDraftReply(intent: Extract<NativeIntent, { kind: 'draft.read' | 'draft.write' }>): unknown {
  const approvedTarget = [target, offlineTarget].find((entry) => entry.targetId === intent.targetId);
  if (!approvedTarget) return { kind: 'error', code: 'TARGET_UNAVAILABLE' };
  if (scenario === 'draft-error') return { kind: 'error', code: 'MOBILE_DRAFT_STORE_UNAVAILABLE' };
  const key = JSON.stringify([approvedTarget.identityKey, intent.sessionId]);
  const drafts = getFixtureDrafts();
  const current = drafts.get(key) ?? { identityKey: approvedTarget.identityKey, agentId: approvedTarget.agentId, sessionId: intent.sessionId, text: '', revision: 0, lastWriteId: null };
  if (intent.kind === 'draft.read') return { kind: 'draft', ...current };
  if (intent.expectedRevision !== current.revision) return { kind: 'error', code: 'MOBILE_DRAFT_CONFLICT' };
  const updated = { ...current, text: intent.text ?? '', revision: current.revision + 1, lastWriteId: intent.writeId ?? null };
  drafts.set(key, updated);
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(fixtureDraftStorageKey, JSON.stringify([...drafts.values()])); } catch { return { kind: 'error', code: 'MOBILE_DRAFT_STORE_UNAVAILABLE' }; }
  return { kind: 'draft', ...updated };
}

function makeSnapshot(sessionId: string, agentId: string, state: Snapshot['state'] = 'idle', generation = 'qa-generation-1', turnId: string | null = null, includeApproval = false): Snapshot {
  const title = sessions.find((item) => item.sessionId === sessionId)?.title ?? '演示会话';
  return {
    kind: 'snapshot', agentId, sessionId, generation, turnId, revision: String(Date.now()), state, title,
    runtime: 'codex', model: '本地演示', terminal: state === 'idle' ? null : null,
    messages: [
      { id: 'qa-message-1', role: 'assistant', timestamp: new Date(Date.now() - 8 * 60_000).toISOString(), content: '你好，我可以帮你整理产品方案。你想先讨论哪一部分？', truncated: false, tools: [] },
      { id: 'qa-message-2', role: 'user', timestamp: new Date(Date.now() - 6 * 60_000).toISOString(), content: '梳理移动端的会话体验，优先解决主界面布局。', truncated: false, tools: [] },
      { id: 'qa-message-3', role: 'assistant', timestamp: new Date(Date.now() - 5 * 60_000).toISOString(), content: '建议把会话内容作为主视图：顶部保留标题、Bot 和成果入口；输入区保持单行，需要附件或语音时再展开辅助操作。', truncated: false, tools: [] },
    ],
    interactions: includeApproval ? [{
      requestId: 'qa-approval-1', generation, turnId: turnId ?? 'qa-turn-1', interaction: 'permission',
      title: '允许读取项目文件？', description: '演示审批卡用于验证审批布局与提交前刷新。', actionable: true, questions: [],
    }] : [],
    hasMoreBefore: false, nextBefore: null,
  };
}

function sessionReply(request: SessionRequest): unknown {
  if (request.kind === 'capabilities') return { kind: 'capabilities', version: 1, agentId: request.agentId, runtime: 'codex', maxActiveSessions: 5, liveUpdates: 'snapshot' };
  if (request.kind === 'list') return { kind: 'list', agentId: request.agentId, items: sessions, hasMore: false, nextBefore: null };
  if (request.kind === 'get') {
    if (staleApprovalNextRead && scenario === 'stale-approval') {
      staleApprovalNextRead = false;
      active = makeSnapshot(request.sessionId, request.agentId, 'waiting_user_action', 'qa-generation-2', 'qa-turn-2', true);
      active.interactions[0].requestId = 'qa-approval-2';
      return active;
    }
    if (!active || active.sessionId !== request.sessionId) {
      const approval = scenario === 'approval' || scenario === 'stale-approval';
      active = makeSnapshot(request.sessionId, request.agentId, approval ? 'waiting_user_action' : 'idle', 'qa-generation-1', approval ? 'qa-turn-1' : null, approval);
    }
    return active;
  }
  if (request.kind === 'respond') {
    active = active ? { ...active, revision: String(Date.now()), state: 'idle', turnId: null, interactions: [], terminal: 'complete' } : null;
    return { kind: 'receipt', agentId: request.agentId, operationId: request.operationId, sessionId: request.sessionId, status: 'accepted', code: null };
  }
  if (request.kind === 'start' || request.kind === 'send') {
    if (scenario === 'unknown-receipt') return { kind: 'receipt', agentId: request.agentId, operationId: request.operationId, sessionId: request.kind === 'send' ? request.sessionId : null, status: 'unconfirmed', code: 'MOBILE_RECEIPT_REQUIRED' };
    const sessionId = request.kind === 'start' ? `qa-session-${sessions.length + 1}` : request.sessionId;
    const prior = request.kind === 'send' ? active?.messages ?? [] : [];
    const text = request.text;
    const title = text.slice(0, 48);
    const now = new Date().toISOString();
    const additions: Snapshot['messages'] = [
      { id: `qa-user-${Date.now()}`, role: 'user', timestamp: now, content: text, truncated: false, tools: [] },
      { id: `qa-reply-${Date.now()}`, role: 'assistant', timestamp: now, content: '可以先从信息架构、消息阅读和输入操作三部分梳理，再逐步补充附件与语音能力。', truncated: false, tools: [] },
    ];
    active = { ...makeSnapshot(sessionId, request.agentId), revision: String(Date.now()), title, terminal: 'complete', messages: [...prior, ...additions].slice(-30) };
    if (request.kind === 'start') sessions = [{ sessionId, title, updatedAt: now, preview: text, runtime: 'codex' }, ...sessions].slice(0, 30);
    return { kind: 'receipt', agentId: request.agentId, operationId: request.operationId, sessionId, status: 'accepted', code: null };
  }
  if (request.kind === 'receipt') return { kind: 'receipt', agentId: request.agentId, operationId: request.operationId, sessionId: active?.sessionId ?? null, status: 'not-found', code: null };
  return { kind: 'error', code: 'QA_FIXTURE_OPERATION_UNSUPPORTED' };
}
