import type { DraftReply, Target } from './native';

export type DraftStatus = 'restoring' | 'saving' | 'saved' | 'unsaved' | 'conflict' | 'error';
export type DraftUpdate = { key: string; ownerEpoch: number; text: string; status: DraftStatus; message?: string; code?: string };
type DraftScope = Pick<Target, 'targetId' | 'identityKey' | 'agentId'>;
type DraftIO = {
  read(targetId: string, sessionId: string | null): Promise<DraftReply>;
  write(targetId: string, sessionId: string | null, expectedRevision: number, writeId: string, text: string): Promise<DraftReply>;
};
type DraftRecord = {
  scope: DraftScope;
  sessionId: string | null;
  key: string;
  text: string;
  revision: number;
  revisionGeneration: number;
  editRevision: number;
  writeGeneration: number;
  dirty: boolean;
  writing: boolean;
  conflicted: boolean;
  conflictRefreshPending: boolean;
  pendingAttempt: PendingAttempt | null;
  timer: ReturnType<typeof setTimeout> | null;
};
type DraftOwner = { key: string; epoch: number };
type PendingAttempt = { writeId: string; text: string; expectedRevision: number; editRevision: number };

export function stableDraftKey(identityKey: string, sessionId: string | null): string {
  return JSON.stringify([identityKey, sessionId]);
}

export class DraftPersistence {
  private readonly records = new Map<string, DraftRecord>();
  private owner: DraftOwner | null = null;
  private accountGeneration = 0;
  private readonly io: DraftIO;
  private readonly onUpdate: (update: DraftUpdate) => void;
  private readonly newWriteId: () => string;
  private readonly debounceMs: number;

  constructor(
    io: DraftIO,
    onUpdate: (update: DraftUpdate) => void,
    newWriteId: () => string,
    debounceMs = 400,
  ) {
    this.io = io;
    this.onUpdate = onUpdate;
    this.newWriteId = newWriteId;
    this.debounceMs = debounceMs;
  }

  activate(scope: DraftScope, sessionId: string | null, ownerEpoch: number): { key: string; text: string; ready: Promise<void> } {
    const key = stableDraftKey(scope.identityKey, sessionId);
    this.owner = { key, epoch: ownerEpoch };
    const record = this.getOrCreate(scope, sessionId, key);
    this.emit(record, record.dirty ? 'unsaved' : 'restoring');
    const ready = this.read(record, ownerEpoch);
    return { key, text: record.text, ready };
  }

  edit(key: string | null, ownerEpoch: number, text: string): void {
    const owner = this.owner;
    const record = key ? this.records.get(key) : undefined;
    if (!record || !owner || owner.key !== key || owner.epoch !== ownerEpoch) return;
    record.text = text;
    record.editRevision += 1;
    record.dirty = true;
    if (!record.conflictRefreshPending) record.conflicted = false;
    if (record.timer) clearTimeout(record.timer);
    this.emit(record, record.conflictRefreshPending ? 'conflict' : 'unsaved');
    if (!record.conflictRefreshPending) {
      record.timer = setTimeout(() => {
        record.timer = null;
        void this.flush(record);
      }, this.debounceMs);
    }
  }

  flushOwner(ownerEpoch: number): Promise<void> {
    const owner = this.owner;
    if (!owner || owner.epoch !== ownerEpoch) return Promise.resolve();
    const record = this.records.get(owner.key);
    if (!record || !record.dirty) return Promise.resolve();
    if (record.timer) { clearTimeout(record.timer); record.timer = null; }
    return this.flush(record);
  }

  deactivate(ownerEpoch: number): void {
    if (this.owner?.epoch === ownerEpoch) this.owner = null;
  }

  clear(): void {
    this.accountGeneration += 1;
    this.owner = null;
    for (const record of this.records.values()) if (record.timer) clearTimeout(record.timer);
    this.records.clear();
  }

  private getOrCreate(scope: DraftScope, sessionId: string | null, key: string): DraftRecord {
    const existing = this.records.get(key);
    if (existing) { existing.scope = scope; return existing; }
    const created: DraftRecord = { scope, sessionId, key, text: '', revision: 0, revisionGeneration: 0, editRevision: 0, writeGeneration: 0, dirty: false, writing: false, conflicted: false, conflictRefreshPending: false, pendingAttempt: null, timer: null };
    this.records.set(key, created);
    return created;
  }

  private owns(record: DraftRecord, ownerEpoch: number): boolean {
    return this.owner?.key === record.key && this.owner.epoch === ownerEpoch && this.records.get(record.key) === record;
  }

  private async read(record: DraftRecord, ownerEpoch: number): Promise<void> {
    const accountGeneration = this.accountGeneration;
    const editRevision = record.editRevision;
    const writeGeneration = record.writeGeneration;
    const revisionGeneration = record.revisionGeneration;
    try {
      const reply = await this.io.read(record.scope.targetId, record.sessionId);
      if (accountGeneration !== this.accountGeneration || !this.owns(record, ownerEpoch) || !this.matches(record, reply)) return;
      const readStillCurrent = record.writeGeneration === writeGeneration && record.revisionGeneration === revisionGeneration;
      if (readStillCurrent) {
        record.revision = reply.revision;
        record.revisionGeneration += 1;
      }
      if (readStillCurrent && record.editRevision === editRevision && !record.dirty && !record.writing) {
        record.text = reply.text;
        this.emit(record, 'saved');
      } else if (record.dirty) this.emit(record, record.conflicted ? 'conflict' : 'unsaved');
    } catch (error) {
      if (accountGeneration !== this.accountGeneration || !this.owns(record, ownerEpoch)) return;
      this.emit(record, 'error', '本机草稿恢复失败；当前编辑内容仍保留。', this.errorCode(error));
    }
  }

  private async flush(record: DraftRecord): Promise<void> {
    if (!record.dirty || record.writing || record.conflicted || this.records.get(record.key) !== record) return;
    if (record.timer) { clearTimeout(record.timer); record.timer = null; }
    record.writing = true;
    const ownerEpoch = this.owner?.key === record.key ? this.owner.epoch : null;
    const accountGeneration = this.accountGeneration;
    const writeGeneration = ++record.writeGeneration;
    if (ownerEpoch !== null) this.emit(record, 'saving');
    try {
      let attempt = record.pendingAttempt;
      if (attempt) {
        const observed = await this.io.read(record.scope.targetId, record.sessionId);
        if (accountGeneration !== this.accountGeneration || this.records.get(record.key) !== record || writeGeneration !== record.writeGeneration) return;
        if (!this.matches(record, observed)) throw new Error('MOBILE_DRAFT_REPLY_INVALID');
        if (observed.lastWriteId === attempt.writeId && observed.revision > attempt.expectedRevision) {
          record.revision = observed.revision;
          record.revisionGeneration += 1;
          record.pendingAttempt = null;
          if (record.editRevision === attempt.editRevision && record.text === attempt.text) record.dirty = false;
          if (!record.dirty) {
            record.writing = false;
            if (ownerEpoch !== null && this.owns(record, ownerEpoch)) this.emit(record, 'saved');
            return;
          }
          attempt = null;
        } else if (observed.revision !== attempt.expectedRevision) {
          record.revision = observed.revision;
          record.revisionGeneration += 1;
          record.pendingAttempt = null;
          record.writing = false;
          record.conflicted = true;
          if (ownerEpoch !== null && this.owns(record, ownerEpoch)) this.emit(record, 'conflict', '草稿版本冲突；当前编辑已保留，继续编辑后再保存。', 'MOBILE_DRAFT_CONFLICT');
          return;
        }
      }
      if (!attempt) {
        attempt = { writeId: this.newWriteId(), text: record.text, expectedRevision: record.revision, editRevision: record.editRevision };
        record.pendingAttempt = attempt;
      }
      const reply = await this.io.write(record.scope.targetId, record.sessionId, attempt.expectedRevision, attempt.writeId, attempt.text);
      if (accountGeneration !== this.accountGeneration || this.records.get(record.key) !== record || writeGeneration !== record.writeGeneration) return;
      if (!this.matches(record, reply) || reply.lastWriteId !== attempt.writeId) throw new Error('MOBILE_DRAFT_REPLY_INVALID');
      record.revision = reply.revision;
      record.revisionGeneration += 1;
      record.pendingAttempt = null;
      record.writing = false;
      if (record.editRevision === attempt.editRevision && record.text === attempt.text) record.dirty = false;
      if (ownerEpoch !== null && this.owns(record, ownerEpoch)) this.emit(record, record.dirty ? 'saving' : 'saved');
      if (record.dirty && !record.conflicted) await this.flush(record);
    } catch (error) {
      if (accountGeneration !== this.accountGeneration || this.records.get(record.key) !== record || writeGeneration !== record.writeGeneration) return;
      record.writing = false;
      record.dirty = true;
      if (this.errorCode(error) === 'MOBILE_DRAFT_CONFLICT') {
        record.pendingAttempt = null;
        record.conflicted = true;
        record.conflictRefreshPending = true;
        if (ownerEpoch !== null && this.owns(record, ownerEpoch)) this.emit(record, 'conflict', '草稿版本冲突；当前编辑已保留，继续编辑后再保存。', 'MOBILE_DRAFT_CONFLICT');
        await this.refreshConflictRevision(record, ownerEpoch, accountGeneration, writeGeneration, record.editRevision);
      } else if (ownerEpoch !== null && this.owns(record, ownerEpoch)) {
        this.emit(record, 'error', '草稿未保存；当前内容仍保留，返回前会再尝试保存。', this.errorCode(error));
      }
    }
  }

  private async refreshConflictRevision(record: DraftRecord, ownerEpoch: number | null, accountGeneration: number, writeGeneration: number, conflictEditRevision: number): Promise<void> {
    try {
      const reply = await this.io.read(record.scope.targetId, record.sessionId);
      if (accountGeneration !== this.accountGeneration || this.records.get(record.key) !== record || record.writeGeneration !== writeGeneration || !this.matches(record, reply)) return;
      record.revision = reply.revision;
      record.revisionGeneration += 1;
      record.conflictRefreshPending = false;
      if (record.editRevision !== conflictEditRevision) record.conflicted = false;
      if (ownerEpoch !== null && this.owns(record, ownerEpoch)) this.emit(record, 'conflict', '草稿版本冲突；当前编辑已保留，继续编辑后再保存。', 'MOBILE_DRAFT_CONFLICT');
      if (record.dirty && !record.conflicted) void this.flush(record);
    } catch (error) {
      if (this.records.get(record.key) === record && record.writeGeneration === writeGeneration) record.conflictRefreshPending = false;
      if (accountGeneration === this.accountGeneration && this.records.get(record.key) === record && ownerEpoch !== null && this.owns(record, ownerEpoch)) {
        this.emit(record, 'conflict', '草稿版本冲突；当前编辑已保留，稍后重试读取。', this.errorCode(error));
      }
    }
  }

  private matches(record: DraftRecord, reply: DraftReply): boolean {
    return reply.kind === 'draft' && reply.identityKey === record.scope.identityKey && reply.agentId === record.scope.agentId && reply.sessionId === record.sessionId;
  }

  private errorCode(error: unknown): string | undefined {
    if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,127}$/.test(error.message)) return error.message;
    return undefined;
  }

  private emit(record: DraftRecord, status: DraftStatus, message?: string, code?: string): void {
    const owner = this.owner;
    if (owner?.key === record.key && this.records.get(record.key) === record) this.onUpdate({ key: record.key, ownerEpoch: owner.epoch, text: record.text, status, ...(message ? { message } : {}), ...(code ? { code } : {}) });
  }
}
