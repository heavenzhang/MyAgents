import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { isProjectArchived, isProjectVisibleToUser } from '../../shared/config-types';
import { workspacePathsEqual } from '../../shared/workspacePath';
import type { ToolAttachment } from '../../shared/types/tool-attachment';
import { getSessionData, getSessionMetadata, isHistoryVisibleSession } from '../SessionStore';
import { getSessionEngine } from '../session-engine';
import { mergeSessionMessagesByIdentity } from '../session-text-projection';
import type { SessionMessage } from '../types/session';
import { resolvePersistedAgentWorkspaceRegistry } from '../utils/agent-workspace-identity';
import { lookupExternalAttachment } from '../runtimes/tool-attachments';
import { getToolAttachmentRoot, validateExternalReadPathNode, validateTrustedAttachmentRoot } from '../utils/path-safety';
import { RemoteSessionError } from './receipts';

const requestSchema = z.object({
  agentId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(99).regex(/^[A-Za-z0-9-]+$/),
  limit: z.number().int().min(1).max(30),
  before: z.string().min(1).max(256).optional(),
}).strict();

const cursorPrefix = 'v1.';
const MAX_ASSET_BYTES = 20 * 1024 * 1024;

interface Cursor {
  messageId: string;
  attachmentIndex: number;
}

interface AttachmentCandidate {
  messageId: string;
  attachmentIndex: number;
  attachment: ToolAttachment;
}

interface OwnerResolvedArtifact {
  root: string;
  relative: string;
  name: string;
  mimeType: string;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  if (!value.startsWith(cursorPrefix)) throw new RemoteSessionError('REMOTE_ASSET_CURSOR_INVALID');
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value.slice(cursorPrefix.length), 'base64url').toString('utf8'));
    const cursor = object(parsed);
    if (typeof cursor.messageId !== 'string' || !cursor.messageId ||
        !Number.isSafeInteger(cursor.attachmentIndex) || (cursor.attachmentIndex as number) < 0) {
      throw new Error('invalid cursor');
    }
    return { messageId: cursor.messageId, attachmentIndex: cursor.attachmentIndex as number };
  } catch {
    throw new RemoteSessionError('REMOTE_ASSET_CURSOR_INVALID');
  }
}

function encodeCursor(cursor: Cursor): string {
  return `${cursorPrefix}${Buffer.from(JSON.stringify(cursor)).toString('base64url')}`;
}

function sanitizeSessionTurnSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || code === 0x7f;
  });
}

function parseToolAttachmentRef(raw: string, sessionId: string): { turnId: string; filename: string } | null {
  const parts = raw.split('/');
  if (parts.length !== 7 || parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'attachment' ||
      parts[3] !== 'tool') return null;
  try {
    const refSession = decodeURIComponent(parts[4]);
    const turnId = decodeURIComponent(parts[5]);
    const filename = decodeURIComponent(parts[6]);
    if (refSession !== sessionId || !/^[A-Za-z0-9_-]+$/.test(refSession) ||
        !/^[A-Za-z0-9_-]+$/.test(turnId) || !filename || filename === '.' || filename === '..' ||
        filename.length > 256 || hasControlCharacter(filename) || filename.includes('/') || filename.includes('\\')) return null;
    return { turnId, filename };
  } catch {
    return null;
  }
}

function collectAttachments(messages: ReadonlyArray<SessionMessage>, sessionId: string): AttachmentCandidate[] {
  const output: AttachmentCandidate[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    let blocks: unknown;
    try { blocks = JSON.parse(message.content); } catch { continue; }
    if (!Array.isArray(blocks)) continue;
    let attachmentIndex = 0;
    const collectTool = (value: unknown, depth: number): void => {
      if (depth > 8) throw new RemoteSessionError('REMOTE_ARTIFACT_UNAVAILABLE');
      const block = object(value);
      if (block.type !== 'tool_use') return;
      const tool = object(block.tool);
      if (Array.isArray(tool.attachments)) {
        for (const raw of tool.attachments) {
          const attachment = object(raw) as unknown as ToolAttachment;
          if (typeof attachment.refPath !== 'string' || !parseToolAttachmentRef(attachment.refPath, sessionId)) {
            throw new RemoteSessionError('REMOTE_ARTIFACT_UNAVAILABLE');
          }
          output.push({ messageId: message.id, attachmentIndex: attachmentIndex++, attachment });
        }
      }
      if (Array.isArray(tool.subagentCalls)) {
        for (const child of tool.subagentCalls) {
          const childTool = object(child);
          if (Array.isArray(childTool.attachments)) {
            for (const raw of childTool.attachments) {
              const attachment = object(raw) as unknown as ToolAttachment;
              if (typeof attachment.refPath !== 'string' || !parseToolAttachmentRef(attachment.refPath, sessionId)) {
                throw new RemoteSessionError('REMOTE_ARTIFACT_UNAVAILABLE');
              }
              output.push({ messageId: message.id, attachmentIndex: attachmentIndex++, attachment });
            }
          }
        }
      }
    };
    for (const block of blocks) collectTool(block, 0);
  }
  return output;
}

async function resolveSource(sessionId: string, attachment: ToolAttachment): Promise<OwnerResolvedArtifact> {
  const parsed = parseToolAttachmentRef(attachment.refPath, sessionId);
  if (!parsed) throw new RemoteSessionError('REMOTE_ARTIFACT_UNAVAILABLE');

  let absolute: string;
  let root: string;
  let relative: string;
  const trustedRoot = getToolAttachmentRoot();
  const storedPath = typeof attachment.savedPath === 'string' ? attachment.savedPath : undefined;
  const expectedTrustedPath = path.join(
    trustedRoot,
    sanitizeSessionTurnSegment(sessionId),
    sanitizeSessionTurnSegment(parsed.turnId),
    parsed.filename,
  );
  const resolvedRoot = path.resolve(trustedRoot);
  const resolvedStoredPath = storedPath ? path.resolve(storedPath) : undefined;
  const storedRelative = resolvedStoredPath ? path.relative(resolvedRoot, resolvedStoredPath) : undefined;
  const storedIsInsideTrustedRoot = storedRelative !== undefined &&
    !path.isAbsolute(storedRelative) && storedRelative !== '..' &&
    !storedRelative.startsWith(`..${path.sep}`);
  if (storedIsInsideTrustedRoot) {
    if (resolvedStoredPath !== path.resolve(expectedTrustedPath) ||
        !validateTrustedAttachmentRoot(expectedTrustedPath, { canonicalizeSymlinks: true }).ok) {
      throw new RemoteSessionError('REMOTE_ARTIFACT_UNAVAILABLE');
    }
    const [canonicalRoot, canonicalFile] = await Promise.all([
      realpath(trustedRoot).catch(() => null),
      realpath(expectedTrustedPath).catch(() => null),
    ]);
    if (!canonicalRoot || !canonicalFile) throw new RemoteSessionError('REMOTE_ARTIFACT_UNAVAILABLE');
    const checkedRelative = path.relative(canonicalRoot, canonicalFile);
    if (!checkedRelative || path.isAbsolute(checkedRelative) || checkedRelative.split(path.sep).some((part) => part === '..')) {
      throw new RemoteSessionError('REMOTE_ARTIFACT_UNAVAILABLE');
    }
    absolute = canonicalFile;
    root = canonicalRoot;
    relative = path.relative(root, absolute);
  } else {
    const registered = lookupExternalAttachment(sessionId, parsed.turnId, parsed.filename);
    if (!registered || (storedPath && path.resolve(storedPath) !== path.resolve(registered))) {
      throw new RemoteSessionError('REMOTE_ARTIFACT_UNAVAILABLE');
    }
    const checked = validateExternalReadPathNode(registered, { canonicalizeSymlinks: true });
    if (!checked.ok) throw new RemoteSessionError('REMOTE_ARTIFACT_UNAVAILABLE');
    absolute = await realpath(checked.canonical).catch(() => {
      throw new RemoteSessionError('REMOTE_ARTIFACT_UNAVAILABLE');
    });
    root = path.dirname(absolute);
    relative = path.basename(absolute);
  }

  const parts = relative.split(path.sep);
  if (path.isAbsolute(relative) || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new RemoteSessionError('REMOTE_ARTIFACT_UNAVAILABLE');
  }
  const stat = await lstat(absolute).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_ASSET_BYTES) {
    throw new RemoteSessionError('REMOTE_ARTIFACT_UNAVAILABLE');
  }
  const mimeType = typeof attachment.mimeType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(attachment.mimeType)
    ? attachment.mimeType.slice(0, 128)
    : 'application/octet-stream';
  return { root, relative, name: parsed.filename, mimeType };
}

async function resolveDesktopRemoteArtifactsOwned(value: unknown) {
  const input = requestSchema.parse(value);
  const engine = getSessionEngine();
  const context = engine.getCurrentSessionContext();
  const metadata = getSessionMetadata(input.sessionId);
  if (context.sessionId !== input.sessionId || !context.workspacePath || !metadata ||
      !isHistoryVisibleSession(metadata)) throw new RemoteSessionError('REMOTE_SESSION_NOT_FOUND');

  const registry = await resolvePersistedAgentWorkspaceRegistry();
  const identity = registry.agentProjections.find((item) => item.agentId === input.agentId);
  if (!identity || registry.diagnostics.some((diagnostic) => diagnostic.agentIds.includes(input.agentId)) ||
      identity.agent.enabled !== true || !identity.project || !isProjectVisibleToUser(identity.project) ||
      isProjectArchived(identity.project) || !workspacePathsEqual(metadata.agentDir, identity.workspacePath) ||
      !workspacePathsEqual(context.workspacePath, identity.workspacePath)) {
    throw new RemoteSessionError('REMOTE_AGENT_UNAVAILABLE');
  }

  const stored = await getSessionData(input.sessionId);
  if (!stored || stored.transcriptRecovery === 'unavailable') throw new RemoteSessionError('REMOTE_HISTORY_UNAVAILABLE');
  const overlay = engine.getLiveSessionOverlay(input.sessionId);
  const live = overlay.isActive && context.sessionId === input.sessionId;
  const messages = mergeSessionMessagesByIdentity(
    live && stored.transcriptFormat === 2 ? [] : stored.messages,
    live ? overlay.inMemoryMessages : undefined,
    live ? overlay.liveStreamingMessage : undefined,
  );
  const candidates = collectAttachments(messages, input.sessionId);
  const cursor = decodeCursor(input.before);
  let start = 0;
  if (cursor) {
    const index = candidates.findIndex((candidate) => candidate.messageId === cursor.messageId &&
      candidate.attachmentIndex === cursor.attachmentIndex);
    if (index < 0) throw new RemoteSessionError('REMOTE_ASSET_CURSOR_INVALID');
    start = index + 1;
  }
  const page = candidates.slice(start, start + input.limit);
  const items = await Promise.all(page.map(({ attachment }) => resolveSource(input.sessionId, attachment)));
  const hasMore = start + page.length < candidates.length;
  const last = page.at(-1);
  const nextBefore = hasMore && last
    ? encodeCursor({ messageId: last.messageId, attachmentIndex: last.attachmentIndex })
    : null;
  return { success: true as const, data: { agentId: input.agentId, sessionId: input.sessionId, items, hasMore, nextBefore } };
}

export async function resolveDesktopRemoteArtifacts(value: unknown) {
  try {
    return await resolveDesktopRemoteArtifactsOwned(value);
  } catch (error) {
    return {
      success: false as const,
      code: error instanceof RemoteSessionError ? error.code : 'REMOTE_ARTIFACT_UNAVAILABLE',
    };
  }
}
