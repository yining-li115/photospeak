/**
 * Process-wide coordination between recorder starts and account resets.
 *
 * JavaScript runs each synchronous section atomically. A start therefore
 * either obtains a permit before reset begins (and is included in that
 * reset's barrier), or observes the active reset and is refused. Advancing the
 * generation also invalidates every older permit at its next await boundary.
 */
export interface RecorderStartPermit {
  readonly generation: number;
  readonly settled: Promise<void>;
  finish(): void;
}

export interface RecorderResetPermit {
  readonly generation: number;
  waitForOverlappingStarts(
    timeoutMs: number
  ): Promise<'settled' | 'timeout'>;
  finish(): void;
}

export class RecorderRuntimeResetBarrier {
  private generation = 0;
  private activeResetCount = 0;
  private readonly starts = new Set<RecorderStartPermit>();

  /**
   * Register synchronously at the very start of start(). A null result means
   * a reset already owns the runtime and no native work may begin.
   */
  beginStart(): RecorderStartPermit | null {
    if (this.activeResetCount > 0) return null;

    const generation = this.generation;
    let finished = false;
    let resolveSettled: (() => void) | null = null;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });

    const permit: RecorderStartPermit = {
      generation,
      settled,
      finish: () => {
        if (finished) return;
        finished = true;
        this.starts.delete(permit);
        resolveSettled?.();
        resolveSettled = null;
      },
    };
    this.starts.add(permit);
    return permit;
  }

  /** Check this after every await and before the next native side effect. */
  isStartCurrent(permit: RecorderStartPermit): boolean {
    return (
      this.activeResetCount === 0 &&
      permit.generation === this.generation &&
      this.starts.has(permit)
    );
  }

  /**
   * Begin synchronously when reset is requested, not when a queued reset later
   * gets CPU time. This closes the snapshot gap for starts already in flight.
   */
  beginReset(): RecorderResetPermit {
    this.generation += 1;
    this.activeResetCount += 1;
    const generation = this.generation;
    const overlappingStarts = [...this.starts].map(
      (attempt) => attempt.settled
    );
    let finished = false;

    return {
      generation,
      waitForOverlappingStarts: (timeoutMs) => {
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          return Promise.reject(
            new TypeError('recorder reset timeout must be a finite positive duration')
          );
        }
        if (overlappingStarts.length === 0) {
          return Promise.resolve('settled');
        }

        return new Promise((resolve) => {
          let completed = false;
          const finish = (outcome: 'settled' | 'timeout') => {
            if (completed) return;
            completed = true;
            clearTimeout(timer);
            resolve(outcome);
          };
          const timer = setTimeout(() => finish('timeout'), timeoutMs);
          Promise.all(overlappingStarts).then(() => finish('settled'));
        });
      },
      finish: () => {
        if (finished) return;
        finished = true;
        this.activeResetCount = Math.max(0, this.activeResetCount - 1);
      },
    };
  }

  /** Exposed for deterministic policy tests and diagnostics. */
  get resetActive(): boolean {
    return this.activeResetCount > 0;
  }
}
