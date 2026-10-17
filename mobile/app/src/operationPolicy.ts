export type ReceiptState = 'prepared' | 'processing' | 'accepted' | 'rejected' | 'unconfirmed' | 'not-found' | 'unknown';

export type ViewOwner = { epoch: number; screen: 'login' | 'sessions' | 'chat'; targetId: string | null; agentId: string | null; sessionId: string | null };

/** Invalidates an account refresh immediately when the root route loses focus. */
export function createRouteFocusGate() {
  let focused = false;
  let epoch = 0;
  return {
    focus(): number { focused = true; epoch += 1; return epoch; },
    blur(): void { focused = false; epoch += 1; },
    capture(): number { return epoch; },
    isCurrent(captured: number): boolean { return focused && captured === epoch; },
  };
}

/** Shared across effect lifetimes so an old owner cannot overlap a new poll while its RPC is pending. */
export function createPollFlightGate() {
  let currentLease = 0;
  let nextLease = 0;
  return {
    acquire(): number | null {
      if (currentLease) return null;
      currentLease = ++nextLease;
      return currentLease;
    },
    release(lease: number) {
      if (currentLease === lease) currentLease = 0;
    },
  };
}

/** A recurring native poll may own at most one request until that request settles. */
export function createSingleFlightPoll(task: (isCurrent: () => boolean) => Promise<void>, eligible: () => boolean, gate = createPollFlightGate()) {
  let active = true;
  let inFlight = false;
  let generation = 0;
  return {
    tick(): Promise<boolean> | null {
      if (!active || inFlight || !eligible()) return null;
      const lease = gate.acquire();
      if (lease === null) return null;
      inFlight = true;
      const requestGeneration = ++generation;
      const isCurrent = () => active && requestGeneration === generation && eligible();
      return Promise.resolve().then(() => task(isCurrent)).then(() => true, () => false).then((completed) => {
        if (active && requestGeneration === generation) inFlight = false;
        gate.release(lease);
        return completed;
      });
    },
    stop() {
      active = false;
      generation += 1;
    },
  };
}

/** Async view reads may commit only while their exact screen/target/session still owns the view. */
export function viewStillOwned(captured: ViewOwner, current: ViewOwner): boolean {
  return captured.epoch === current.epoch
    && captured.screen === current.screen
    && captured.targetId === current.targetId
    && captured.agentId === current.agentId
    && captured.sessionId === current.sessionId;
}

export function commitIfViewOwned<T>(captured: ViewOwner, current: ViewOwner, value: T, commit: (value: T) => void): boolean {
  if (!viewStillOwned(captured, current)) return false;
  commit(value);
  return true;
}

/** Draft keys use returned target identity as a storage namespace, never as bridge authorization. */
export function draftKey(target: { identityKey: string } | null, sessionId: string | null): string | null {
  if (!target) return null;
  return JSON.stringify([target.identityKey, sessionId]);
}

/** A mutation UUID may be submitted once. Later interaction is always a receipt query. */
export function mutationDisposition(status: ReceiptState): 'query-only' | 'settled' {
  return status === 'accepted' || status === 'rejected' ? 'settled' : 'query-only';
}

export function approvalStillCurrent(current: { state: string; generation: string | null; turnId: string | null; interactions: readonly { requestId: string; generation: string; turnId: string; actionable: boolean }[] }, captured: { requestId: string; generation: string; turnId: string }): boolean {
  return current.state === 'waiting_user_action'
    && current.generation === captured.generation
    && current.turnId === captured.turnId
    && current.interactions.some((item) => item.requestId === captured.requestId && item.generation === captured.generation && item.turnId === captured.turnId && item.actionable);
}
