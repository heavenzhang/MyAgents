import assert from 'node:assert/strict';
import test from 'node:test';
import { DraftPersistence, stableDraftKey, type DraftUpdate } from '../src/draftPersistence.ts';
import type { DraftReply, Target } from '../src/native.ts';

const target: Target = { targetId: 'approved-target-a', identityKey: 'opaque-account-service-network-device-agent-a', agentId: 'agent-a', name: 'Bot A', deviceName: 'Host', online: true, runtime: null };
const renamedTarget: Target = { ...target, targetId: 'rebound-approved-target-a', name: 'Renamed Bot A' };
const otherTarget: Target = { ...target, identityKey: 'opaque-account-b-service-network-device-agent-a', targetId: 'approved-target-b', name: 'Bot A' };
const writeIds = () => {
  let serial = 0;
  return () => `00000000-0000-4000-8000-${String(++serial).padStart(12, '0')}`;
};
const reply = (scope: Target, sessionId: string | null, text = '', revision = 0, lastWriteId: string | null = null): DraftReply => ({ kind: 'draft', identityKey: scope.identityKey, agentId: scope.agentId, sessionId, text, revision, lastWriteId });
const keyFor = (scope: Target, sessionId: string | null) => stableDraftKey(scope.identityKey, sessionId);

function memoryIO() {
  const values = new Map<string, DraftReply>();
  const key = (identityKey: string, sessionId: string | null) => JSON.stringify([identityKey, sessionId]);
  return {
    values,
    io: {
      async read(targetId: string, sessionId: string | null) {
        const scope = [target, renamedTarget, otherTarget].find((entry) => entry.targetId === targetId);
        if (!scope) throw new Error('TARGET_UNAVAILABLE');
        return values.get(key(scope.identityKey, sessionId)) ?? reply(scope, sessionId);
      },
      async write(targetId: string, sessionId: string | null, expectedRevision: number, writeId: string, text: string) {
        const scope = [target, renamedTarget, otherTarget].find((entry) => entry.targetId === targetId);
        if (!scope) throw new Error('TARGET_UNAVAILABLE');
        const current = values.get(key(scope.identityKey, sessionId)) ?? reply(scope, sessionId);
        if (current.revision !== expectedRevision) throw new Error('MOBILE_DRAFT_CONFLICT');
        const updated = reply(scope, sessionId, text, current.revision + 1, writeId);
        values.set(key(scope.identityKey, sessionId), updated);
        return updated;
      },
    },
  };
}

function manager(io: ConstructorParameters<typeof DraftPersistence>[0], updates: DraftUpdate[], debounceMs = 60_000) {
  return new DraftPersistence(io, (update) => updates.push(update), writeIds(), debounceMs);
}

test('draft persistence reloads the device record and survives target display-name changes', async () => {
  const backend = memoryIO();
  const firstUpdates: DraftUpdate[] = [];
  const first = manager(backend.io, firstUpdates);
  const opened = first.activate(target, 'session-a', 1);
  await opened.ready;
  first.edit(opened.key, 1, '草稿在重启后恢复');
  await first.flushOwner(1);
  first.clear();

  const secondUpdates: DraftUpdate[] = [];
  const second = manager(backend.io, secondUpdates);
  const reopened = second.activate(renamedTarget, 'session-a', 1);
  assert.equal(reopened.key, opened.key);
  await reopened.ready;
  assert.equal(secondUpdates.at(-1)?.text, '草稿在重启后恢复');
  assert.equal(secondUpdates.at(-1)?.status, 'saved');
  second.clear();
});

test('typing during a deferred read wins over the late restored value', async () => {
  let resolveRead!: (value: DraftReply) => void;
  const deferred = new Promise<DraftReply>((resolve) => { resolveRead = resolve; });
  const updates: DraftUpdate[] = [];
  const controller = manager({ read: async () => deferred, write: async () => { throw new Error('unexpected write'); } }, updates);
  const opened = controller.activate(target, 'session-a', 7);
  controller.edit(opened.key, 7, '刚输入的内容');
  resolveRead(reply(target, 'session-a', '过期的远端值', 3));
  await opened.ready;
  assert.equal(updates.at(-1)?.text, '刚输入的内容');
  assert.equal(updates.at(-1)?.status, 'unsaved');
  controller.clear();
});

test('a read started before a successful save cannot restore stale text afterward', async () => {
  let deferredResolve!: (value: DraftReply) => void;
  let readCount = 0;
  const backend = memoryIO();
  const delayedRead = new Promise<DraftReply>((resolve) => { deferredResolve = resolve; });
  const updates: DraftUpdate[] = [];
  const controller = manager({
    ...backend.io,
    read: async (targetId, sessionId) => ++readCount === 2 ? delayedRead : backend.io.read(targetId, sessionId),
  }, updates);
  const initial = controller.activate(target, 'session-a', 1);
  await initial.ready;
  controller.edit(initial.key, 1, 'newly saved text');
  const reopened = controller.activate(target, 'session-a', 2);
  const saving = controller.flushOwner(2);
  await saving;
  assert.equal(updates.at(-1)?.status, 'saved');
  deferredResolve(reply(target, 'session-a', 'stale pre-save text', 0));
  await reopened.ready;
  assert.equal(updates.some((update) => update.text === 'stale pre-save text'), false);
  assert.equal(updates.at(-1)?.text, 'newly saved text');
  controller.clear();
});

test('an old owner save cannot publish state into a newly selected target', async () => {
  let resolveWrite!: (value: DraftReply) => void;
  const deferredWrite = new Promise<DraftReply>((resolve) => { resolveWrite = resolve; });
  const backend = memoryIO();
  const updates: DraftUpdate[] = [];
  const controller = manager({
    ...backend.io,
    write: async (targetId, sessionId, expectedRevision, writeId, text) => targetId === target.targetId
      ? deferredWrite
      : backend.io.write(targetId, sessionId, expectedRevision, writeId, text),
  }, updates);
  const openedA = controller.activate(target, 'session-a', 1);
  await openedA.ready;
  controller.edit(openedA.key, 1, 'Bot A dirty');
  const savingA = controller.flushOwner(1);
  await Promise.resolve();
  const openedB = controller.activate(otherTarget, 'session-b', 2);
  await openedB.ready;
  const updateCountAtB = updates.length;
  resolveWrite(reply(target, 'session-a', 'Bot A dirty', 1, '00000000-0000-4000-8000-000000000001'));
  await savingA;
  assert.equal(updates.length, updateCountAtB, 'late A completion does not clear or replace B status');
  assert.equal(updates.at(-1)?.key, openedB.key);
  controller.clear();
});

test('stale revision conflict reads the fresh version but preserves local text until another edit', async () => {
  const backend = memoryIO();
  const updates: DraftUpdate[] = [];
  const controller = manager(backend.io, updates);
  const opened = controller.activate(target, 'session-a', 1);
  await opened.ready;
  backend.values.set(JSON.stringify([target.identityKey, 'session-a']), reply(target, 'session-a', 'other-device latest', 5));
  controller.edit(opened.key, 1, 'this-device draft');
  await controller.flushOwner(1);
  assert.equal(updates.at(-1)?.status, 'conflict');
  assert.equal(updates.at(-1)?.text, 'this-device draft');
  assert.equal(backend.values.get(JSON.stringify([target.identityKey, 'session-a']))?.text, 'other-device latest');

  controller.edit(opened.key, 1, 'this-device confirmed edit');
  await controller.flushOwner(1);
  assert.equal(backend.values.get(JSON.stringify([target.identityKey, 'session-a']))?.text, 'this-device confirmed edit');
  controller.clear();
});

test('typing during a slow save queues only the newest text and a write failure keeps dirty text', async () => {
  const backend = memoryIO();
  const writes: { text: string; expectedRevision: number }[] = [];
  let resolveFirst!: (value: DraftReply) => void;
  const firstWrite = new Promise<DraftReply>((resolve) => { resolveFirst = resolve; });
  const updates: DraftUpdate[] = [];
  let shouldFail = false;
  const controller = manager({
    ...backend.io,
    write: async (targetId, sessionId, expectedRevision, writeId, text) => {
      writes.push({ text, expectedRevision });
      if (shouldFail) throw new Error('MOBILE_DRAFT_STORE_UNAVAILABLE');
      if (writes.length === 1) return firstWrite;
      return backend.io.write(targetId, sessionId, expectedRevision, writeId, text);
    },
  }, updates);
  const opened = controller.activate(target, 'session-a', 1);
  await opened.ready;
  controller.edit(opened.key, 1, 'first');
  const firstFlush = controller.flushOwner(1);
  await Promise.resolve();
  controller.edit(opened.key, 1, 'latest');
  resolveFirst(reply(target, 'session-a', 'first', 1, '00000000-0000-4000-8000-000000000001'));
  await firstFlush;
  assert.deepEqual(writes.map((item) => item.text), ['first', 'latest']);
  assert.deepEqual(writes.map((item) => item.expectedRevision), [0, 1]);

  shouldFail = true;
  controller.edit(opened.key, 1, 'preserve after failure');
  await controller.flushOwner(1);
  assert.equal(updates.at(-1)?.status, 'error');
  assert.equal(updates.at(-1)?.text, 'preserve after failure');
  shouldFail = false;
  controller.clear();
});

test('a lost write acknowledgement is resolved by retrying the same idempotency key', async () => {
  const backend = memoryIO();
  const current = new Map<string, DraftReply>();
  const writeCalls: { writeId: string; revision: number; text: string }[] = [];
  let readCount = 0;
  let writeCount = 0;
  const io = {
    async read(targetId: string, sessionId: string | null) {
      if (++readCount === 2) return reply(target, sessionId, '', 0);
      return current.get(JSON.stringify([target.identityKey, sessionId])) ?? backend.io.read(targetId, sessionId);
    },
    async write(targetId: string, sessionId: string | null, expectedRevision: number, writeId: string, text: string) {
      writeCalls.push({ writeId, revision: expectedRevision, text });
      const key = JSON.stringify([target.identityKey, sessionId]);
      const alreadyCommitted = current.get(key);
      if (alreadyCommitted?.lastWriteId === writeId) return alreadyCommitted;
      if (expectedRevision !== (alreadyCommitted?.revision ?? 0)) throw new Error('MOBILE_DRAFT_CONFLICT');
      const saved = reply(target, sessionId, text, expectedRevision + 1, writeId);
      current.set(key, saved);
      if (++writeCount === 1) throw new Error('MOBILE_REMOTE_UNAVAILABLE');
      return saved;
    },
  };
  const updates: DraftUpdate[] = [];
  const controller = manager(io, updates);
  const opened = controller.activate(target, 'session-a', 1);
  await opened.ready;
  controller.edit(opened.key, 1, 'first attempt');
  await controller.flushOwner(1);
  assert.equal(current.get(JSON.stringify([target.identityKey, 'session-a']))?.text, 'first attempt');
  controller.edit(opened.key, 1, 'newer edit');
  await controller.flushOwner(1);
  assert.equal(writeCalls.length, 3);
  assert.deepEqual(writeCalls.slice(0, 2).map((call) => [call.writeId, call.revision, call.text]), [
    [writeCalls[0].writeId, 0, 'first attempt'],
    [writeCalls[0].writeId, 0, 'first attempt'],
  ]);
  assert.notEqual(writeCalls[2].writeId, writeCalls[0].writeId);
  assert.deepEqual(writeCalls[2], { writeId: writeCalls[2].writeId, revision: 1, text: 'newer edit' });
  assert.equal(current.get(JSON.stringify([target.identityKey, 'session-a']))?.text, 'newer edit');
  controller.clear();
});

test('identity and session keys never collide even when visible names match', () => {
  assert.notEqual(keyFor(target, 'session-a'), keyFor(otherTarget, 'session-a'));
  assert.notEqual(keyFor(target, 'session-a'), keyFor(target, 'session-b'));
  assert.equal(keyFor(target, 'session-a'), keyFor(renamedTarget, 'session-a'));
});
