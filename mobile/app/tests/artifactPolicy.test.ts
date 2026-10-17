import assert from 'node:assert/strict';
import test from 'node:test';
import { ArtifactDownloadTracker, type ArtifactOwner } from '../src/artifactPolicy.ts';
import type { ArtifactDownload } from '../src/native.ts';

const owner: ArtifactOwner = { targetId: 'target-a', identityKey: 'identity-a', agentId: 'agent-a', sessionId: 'session-a' };
const downloading: ArtifactDownload = { kind: 'artifact-download', ...owner, artifactId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', name: 'result.pdf', mimeType: 'application/pdf', sha256: 'a'.repeat(64), state: 'downloading', receivedBytes: 0, totalBytes: 100, errorCode: null };

test('a ready event that arrives before a delayed initial download reply remains authoritative', () => {
  const tracker = new ArtifactDownloadTracker();
  const epoch = tracker.activate(owner);
  const flight = tracker.begin(downloading.artifactId, epoch);
  let visible = downloading;
  const ready = { ...downloading, state: 'ready' as const, receivedBytes: 100 };
  assert.equal(tracker.acceptEvent(ready, epoch), true);
  visible = ready;
  assert.equal(tracker.acceptReply(downloading, flight), false);
  assert.equal(visible.state, 'ready');
});

test('late events and replies from a prior target owner cannot mutate the new owner state', () => {
  const tracker = new ArtifactDownloadTracker();
  const firstEpoch = tracker.activate(owner);
  const flight = tracker.begin(downloading.artifactId, firstEpoch);
  const secondOwner = { ...owner, targetId: 'target-b', identityKey: 'identity-b', agentId: 'agent-b' };
  const secondEpoch = tracker.activate(secondOwner);
  assert.equal(tracker.acceptEvent({ ...downloading, state: 'ready', receivedBytes: 100 }, firstEpoch), false);
  assert.equal(tracker.acceptReply(downloading, flight), false);
  assert.equal(tracker.isCurrent(secondEpoch, secondOwner), true);
});

test('route blur invalidates an outstanding status response', () => {
  const tracker = new ArtifactDownloadTracker();
  const epoch = tracker.activate(owner);
  const flight = tracker.begin(downloading.artifactId, epoch);
  tracker.blur();
  assert.equal(tracker.acceptReply(downloading, flight), false);
});
