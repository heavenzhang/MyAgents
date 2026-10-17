import type { NativeAttachmentUpload } from './native';

type UploadScope = Pick<NativeAttachmentUpload, 'localId' | 'targetId' | 'identityKey' | 'agentId' | 'uploadId'>;
export type UploadFlight = { localId: string; generation: number; eventVersion: number };

function matchesScope(upload: NativeAttachmentUpload, scope: UploadScope): boolean {
  return upload.localId === scope.localId && upload.targetId === scope.targetId
    && upload.identityKey === scope.identityKey && upload.agentId === scope.agentId
    && upload.uploadId === scope.uploadId;
}

function isTerminal(upload: NativeAttachmentUpload): boolean {
  return upload.state === 'ready' || upload.state === 'cancelled';
}

/** Keeps event/reply ordering monotonic and lets callers await a scoped native outcome. */
export class AttachmentUploadTracker {
  private readonly latest = new Map<string, NativeAttachmentUpload>();
  private readonly eventVersions = new Map<string, number>();
  private generation = 0;
  private readonly waiters = new Map<string, Set<{
    scope: UploadScope;
    acceptPausedError: boolean;
    resolve: (upload: NativeAttachmentUpload | null) => void;
  }>>();

  captureFlight(localId: string): UploadFlight {
    return { localId, generation: this.generation, eventVersion: this.eventVersions.get(localId) ?? 0 };
  }

  publishEvent(incoming: NativeAttachmentUpload): NativeAttachmentUpload {
    this.eventVersions.set(incoming.localId, (this.eventVersions.get(incoming.localId) ?? 0) + 1);
    return this.commit(incoming);
  }

  publishReply(incoming: NativeAttachmentUpload, flight: UploadFlight): NativeAttachmentUpload | null {
    if (flight.localId !== incoming.localId || flight.generation !== this.generation) return null;
    if ((this.eventVersions.get(incoming.localId) ?? 0) > flight.eventVersion) return this.latest.get(incoming.localId) ?? null;
    return this.commit(incoming);
  }

  private commit(next: NativeAttachmentUpload): NativeAttachmentUpload {
    this.latest.set(next.localId, next);
    const waiting = this.waiters.get(next.localId);
    if (waiting) {
      for (const waiter of [...waiting]) {
        if (!matchesScope(next, waiter.scope)) continue;
        if (isTerminal(next) || (waiter.acceptPausedError && next.state === 'paused' && next.errorCode)) {
          waiting.delete(waiter);
          waiter.resolve(next);
        }
      }
      if (waiting.size === 0) this.waiters.delete(next.localId);
    }
    return next;
  }

  current(localId: string): NativeAttachmentUpload | null {
    return this.latest.get(localId) ?? null;
  }

  wait(scope: UploadScope, acceptPausedError = false): Promise<NativeAttachmentUpload | null> {
    const current = this.latest.get(scope.localId);
    if (current && matchesScope(current, scope)
      && (isTerminal(current) || (acceptPausedError && current.state === 'paused' && current.errorCode))) {
      return Promise.resolve(current);
    }
    return new Promise((resolve) => {
      const waiting = this.waiters.get(scope.localId) ?? new Set();
      waiting.add({ scope, acceptPausedError, resolve });
      this.waiters.set(scope.localId, waiting);
    });
  }

  invalidate(): void {
    this.generation += 1;
    for (const waiting of this.waiters.values()) for (const waiter of waiting) waiter.resolve(null);
    this.waiters.clear();
    this.latest.clear();
    this.eventVersions.clear();
  }
}

export function isConfirmedUploadRecordAbsence(code: string): boolean {
  return code === 'MOBILE_ATTACHMENT_UPLOAD_NOT_FOUND' || code === 'MOBILE_UPLOAD_NOT_FOUND';
}
