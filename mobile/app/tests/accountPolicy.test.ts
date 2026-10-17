import assert from 'node:assert/strict';
import test from 'node:test';
import { dismissToExistingRoot, logoutAndConfirm, returnFromAccountRoute } from '../src/accountPolicy.ts';

test('logout waits for signed-out confirmation before dismissing to the existing session owner', async () => {
  let resolveReply!: (reply: { kind: 'account'; state: 'signed-out'; displayName: null; principalId: null }) => void;
  const navigation: string[] = [];
  const flight = logoutAndConfirm(
    () => new Promise((resolve) => { resolveReply = resolve; }),
    () => dismissToExistingRoot(() => navigation.push('dismiss-existing-root')),
  );
  await Promise.resolve();
  assert.deepEqual(navigation, []);
  resolveReply({ kind: 'account', state: 'signed-out', displayName: null, principalId: null });
  assert.equal(await flight, 'confirmed');
  assert.deepEqual(navigation, ['dismiss-existing-root']);
});

test('logout leaves the route in place when native has not confirmed signed out', async () => {
  let returned = false;
  const result = await logoutAndConfirm(async () => ({ kind: 'account', state: 'authenticating', displayName: null, principalId: null }), () => { returned = true; });
  assert.equal(result, 'not-confirmed');
  assert.equal(returned, false);
});

test('native logout errors do not trigger navigation', async () => {
  let returned = false;
  await assert.rejects(() => logoutAndConfirm(async () => ({ kind: 'error', code: 'MOBILE_REMOTE_UNAVAILABLE' }), () => { returned = true; }), /MOBILE_REMOTE_UNAVAILABLE/);
  assert.equal(returned, false);
});

test('an account deep link returns to the app root when the router has no in-app back entry', () => {
  const actions: string[] = [];
  returnFromAccountRoute(() => false, () => actions.push('back'), () => actions.push('home'));
  assert.deepEqual(actions, ['home']);
  returnFromAccountRoute(() => true, () => actions.push('back'), () => actions.push('home'));
  assert.deepEqual(actions, ['home', 'back']);
});
