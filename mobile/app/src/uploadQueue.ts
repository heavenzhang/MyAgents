/** Serializes upload jobs while allowing an owner switch to invalidate queued work. */
export class SerialUploadQueue {
  private ownerEpoch = 0;
  private tail: Promise<void> = Promise.resolve();

  currentEpoch(): number { return this.ownerEpoch; }

  invalidate(): void { this.ownerEpoch += 1; }

  enqueue(epoch: number, job: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    const run = this.tail.catch(() => undefined).then(async () => {
      const isCurrent = () => epoch === this.ownerEpoch;
      if (isCurrent()) await job(isCurrent);
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}
