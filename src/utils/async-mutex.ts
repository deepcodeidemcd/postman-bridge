export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;

  get queueLength(): number {
    return this.waiting;
  }

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.waiting += 1;
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => next);

    await previous;
    this.waiting -= 1;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
