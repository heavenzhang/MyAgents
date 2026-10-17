import type { ArtifactDownload } from './native';

export type ArtifactOwner = { targetId: string; identityKey: string; agentId: string; sessionId: string };
export type ArtifactDownloadFlight = { epoch: number; artifactId: string; eventVersion: number };

function sameOwner(left: ArtifactOwner, right: ArtifactOwner): boolean {
  return left.targetId === right.targetId && left.identityKey === right.identityKey
    && left.agentId === right.agentId && left.sessionId === right.sessionId;
}

/** Fences native replies and event callbacks to the visible target/session and its latest event. */
export class ArtifactDownloadTracker {
  private owner: ArtifactOwner | null = null;
  private epoch = 0;
  private eventVersions = new Map<string, number>();
  private latestValues = new Map<string, ArtifactDownload>();

  activate(owner: ArtifactOwner): number {
    this.owner = owner;
    this.epoch += 1;
    this.eventVersions.clear();
    this.latestValues.clear();
    return this.epoch;
  }

  blur(): void {
    this.owner = null;
    this.epoch += 1;
    this.eventVersions.clear();
    this.latestValues.clear();
  }

  isCurrent(epoch: number, owner?: ArtifactOwner): boolean {
    return this.epoch === epoch && this.owner !== null && (!owner || sameOwner(this.owner, owner));
  }

  begin(artifactId: string, epoch: number): ArtifactDownloadFlight {
    return { epoch, artifactId, eventVersion: this.eventVersions.get(artifactId) ?? 0 };
  }

  acceptEvent(event: ArtifactDownload, epoch: number): boolean {
    if (!this.isCurrent(epoch) || !this.matches(event)) return false;
    this.eventVersions.set(event.artifactId, (this.eventVersions.get(event.artifactId) ?? 0) + 1);
    this.latestValues.set(event.artifactId, event);
    return true;
  }

  acceptReply(reply: ArtifactDownload, flight: ArtifactDownloadFlight): boolean {
    const accepted = this.isCurrent(flight.epoch) && reply.artifactId === flight.artifactId
      && (this.eventVersions.get(flight.artifactId) ?? 0) === flight.eventVersion && this.matches(reply);
    if (accepted) this.latestValues.set(reply.artifactId, reply);
    return accepted;
  }

  acceptAbsence(flight: ArtifactDownloadFlight): boolean {
    return this.isCurrent(flight.epoch) && (this.eventVersions.get(flight.artifactId) ?? 0) === flight.eventVersion;
  }

  latest(artifactId: string, epoch: number): ArtifactDownload | null {
    return this.isCurrent(epoch) ? this.latestValues.get(artifactId) ?? null : null;
  }

  private matches(value: ArtifactDownload): boolean {
    return !!this.owner && value.targetId === this.owner.targetId && value.identityKey === this.owner.identityKey
      && value.agentId === this.owner.agentId && value.sessionId === this.owner.sessionId;
  }
}

export function artifactListBelongsToOwner(value: { targetId: string; identityKey: string; agentId: string; sessionId: string }, owner: ArtifactOwner): boolean {
  return sameOwner(value, owner);
}
