import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalStillCurrent, commitIfViewOwned, createPollFlightGate, createRouteFocusGate, createSingleFlightPoll, draftKey, mutationDisposition } from '../src/operationPolicy.ts';

test('an unknown mutation is query-only and cannot be submitted a second time', () => {
  assert.equal(mutationDisposition('unknown'), 'query-only');
  assert.equal(mutationDisposition('unconfirmed'), 'query-only');
  assert.equal(mutationDisposition('not-found'), 'query-only');
  assert.equal(mutationDisposition('processing'), 'query-only');
  assert.equal(mutationDisposition('accepted'), 'settled');
  assert.equal(mutationDisposition('rejected'), 'settled');
});

test('approval requires the same current request, generation, turn, and actionable state', () => {
  const current = { state: 'waiting_user_action', generation: 'g1', turnId: 't1', interactions: [{ requestId: 'r1', generation: 'g1', turnId: 't1', actionable: true }] };
  assert.equal(approvalStillCurrent(current, { requestId: 'r1', generation: 'g1', turnId: 't1' }), true);
  assert.equal(approvalStillCurrent({ ...current, turnId: 't2' }, { requestId: 'r1', generation: 'g1', turnId: 't1' }), false);
  assert.equal(approvalStillCurrent(current, { requestId: 'stale', generation: 'g1', turnId: 't1' }), false);
  assert.equal(approvalStillCurrent({ ...current, state: 'running' }, { requestId: 'r1', generation: 'g1', turnId: 't1' }), false);
});

test('a deferred Bot A list response cannot overwrite the currently selected Bot B list', async () => {
  const ownerA = { epoch: 4, screen: 'sessions' as const, targetId: 'target-a', agentId: 'agent-a', sessionId: null };
  const ownerB = { epoch: 5, screen: 'sessions' as const, targetId: 'target-b', agentId: 'agent-b', sessionId: null };
  let resolveA!: (value: string[]) => void;
  const deferredA = new Promise<string[]>((resolve) => { resolveA = resolve; });
  let visible = ['Bot B current session'];
  const oldRequest = deferredA.then((value) => commitIfViewOwned(ownerA, ownerB, value, (sessions) => { visible = sessions; }));
  resolveA(['Bot A stale session']);
  assert.equal(await oldRequest, false);
  assert.deepEqual(visible, ['Bot B current session']);
});

test('draft keys use stable native target identity and isolate sessions across renames/accounts', () => {
  const targetA = { identityKey: 'opaque-account-a-host-1-agent-a' };
  const renamedTargetA = { identityKey: 'opaque-account-a-host-1-agent-a' };
  const targetB = { identityKey: 'opaque-account-b-host-1-agent-a' };
  const keyA = draftKey(targetA, 'session-a');
  const renamedKeyA = draftKey(renamedTargetA, 'session-a');
  const newKeyA = draftKey(targetA, null);
  assert.equal(renamedKeyA, keyA, 'display-name changes do not lose the stored draft');
  assert.notEqual(draftKey(targetB, 'session-b'), keyA, 'a different account has an isolated draft');
  assert.notEqual(draftKey(targetA, 'session-b'), keyA, 'drafts remain isolated by session');
  assert.notEqual(draftKey({ identityKey: 'other-account-same-agent-name' }, 'session-a'), keyA, 'different native account identities do not collide');
  assert.notEqual(newKeyA, keyA, 'a new conversation has a separate draft');
});

test('slow polling stays single-flight and only commits while its app and view owner remain current', async () => {
  let resolveRequest!: () => void;
  const deferred = new Promise<void>((resolve) => { resolveRequest = resolve; });
  const appActive = true;
  let selectedOwner = 'Bot A';
  let commits = 0;
  let requests = 0;
  const poll = createSingleFlightPoll(async (isCurrent) => {
    requests += 1;
    await deferred;
    if (isCurrent() && selectedOwner === 'Bot A') commits += 1;
  }, () => appActive && selectedOwner === 'Bot A');

  const first = poll.tick();
  assert.ok(first);
  assert.equal(poll.tick(), null, 'a timer tick cannot start another request while one is pending');
  selectedOwner = 'Bot B';
  resolveRequest();
  assert.equal(await first, true);
  assert.equal(requests, 1);
  assert.equal(commits, 0, 'a late Bot A result cannot commit into Bot B');
  assert.equal(poll.tick(), null, 'the old owner no longer schedules requests');
  poll.stop();
});

test('background state and effect cleanup prevent native poll dispatch or late commits', async () => {
  let appActive = false;
  let accountRefreshing = true;
  let dispatched = 0;
  let resolveRequest!: () => void;
  const deferred = new Promise<void>((resolve) => { resolveRequest = resolve; });
  let commits = 0;
  const poll = createSingleFlightPoll(async (isCurrent) => {
    dispatched += 1;
    await deferred;
    if (isCurrent()) commits += 1;
  }, () => appActive && !accountRefreshing);

  assert.equal(poll.tick(), null, 'background polling is suppressed');
  appActive = true;
  assert.equal(poll.tick(), null, 'snapshot polling waits for the existing foreground account refresh');
  accountRefreshing = false;
  const inFlight = poll.tick();
  assert.ok(inFlight);
  poll.stop();
  assert.equal(poll.tick(), null, 'cleanup prevents a scheduled follow-up tick');
  resolveRequest();
  assert.equal(await inFlight, true);
  assert.equal(dispatched, 1);
  assert.equal(commits, 0, 'cleanup invalidates the request before it can update the UI');
});

test('an owner change cannot start a second poll until the previous native request settles', async () => {
  const gate = createPollFlightGate();
  let resolveOld!: () => void;
  const oldRequest = new Promise<void>((resolve) => { resolveOld = resolve; });
  let oldOwnerCurrent = true;
  let dispatched = 0;
  let commits = 0;
  const oldPoll = createSingleFlightPoll(async (isCurrent) => {
    dispatched += 1;
    await oldRequest;
    if (isCurrent() && oldOwnerCurrent) commits += 1;
  }, () => oldOwnerCurrent, gate);
  const oldFlight = oldPoll.tick();
  assert.ok(oldFlight);
  await Promise.resolve();

  oldOwnerCurrent = false;
  oldPoll.stop();
  const newPoll = createSingleFlightPoll(async (isCurrent) => {
    dispatched += 1;
    if (isCurrent()) commits += 1;
  }, () => true, gate);
  assert.equal(newPoll.tick(), null, 'the new owner waits for the outstanding native RPC instead of queuing another');
  assert.equal(dispatched, 1);

  resolveOld();
  await oldFlight;
  const newFlight = newPoll.tick();
  assert.ok(newFlight);
  await newFlight;
  assert.equal(dispatched, 2);
  assert.equal(commits, 1, 'the old owner response is discarded and only the current owner commits');
  newPoll.stop();
});

test('leaving the root route during account status prevents target dispatch and stale owner commits', async () => {
  const focus = createRouteFocusGate();
  const token = focus.focus();
  let resolveAccount!: () => void;
  const accountStatus = new Promise<void>((resolve) => { resolveAccount = resolve; });
  let targetRequests = 0;
  let ownerCommits = 0;
  const refresh = (captured: number) => accountStatus.then(() => {
    if (!focus.isCurrent(captured)) return;
    targetRequests += 1;
    if (focus.isCurrent(captured)) ownerCommits += 1;
  });

  const pendingRefresh = refresh(token);
  focus.blur();
  resolveAccount();
  await pendingRefresh;
  assert.equal(targetRequests, 0, 'a deferred status reply must not trigger targets.list after the root route blurs');
  assert.equal(ownerCommits, 0, 'a stale account reply cannot mutate the shared session owner');
});

test('a queued login or snapshot tick cannot dispatch native RPC after route blur', async () => {
  const focus = createRouteFocusGate();
  const token = focus.focus();
  let nativeCalls = 0;
  const poll = createSingleFlightPoll(async (isCurrent) => {
    if (!isCurrent()) return;
    nativeCalls += 1;
  }, () => focus.isCurrent(token));
  const pendingTick = poll.tick();
  assert.ok(pendingTick);
  focus.blur();
  await pendingTick;
  assert.equal(nativeCalls, 0, 'the poll task checks route ownership immediately before dispatch');
});
