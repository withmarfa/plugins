import type { Clock } from "./runtime.js";

/** The longest a read of the connector's control door may take before the
 *  run starts as scheduled without it. */
export const controlReadMs = 10_000;

/**
 * Wakes the schedule when the host asks for a run now. A request that
 * arrives while the connector sleeps ends the sleep; one that arrives during
 * a run, however many, makes the sleep after it end at once, so one more run
 * follows and never two.
 */
export class Wake {
  private asked = false;
  private napping: AbortController | undefined;

  constructor(private readonly clock: Clock) {}

  request(): void {
    if (this.napping === undefined) this.asked = true;
    else this.napping.abort();
  }

  /** Sleeps until `ms` pass, `signal` aborts or a run is asked for.
   *  Answers whether a run was asked for. */
  async sleep(ms: number, signal: AbortSignal): Promise<boolean> {
    if (this.asked) {
      this.asked = false;
      return true;
    }
    if (signal.aborted) return false;
    const nap = new AbortController();
    this.napping = nap;
    try {
      await this.clock.sleep(ms, AbortSignal.any([signal, nap.signal]));
    } finally {
      this.napping = undefined;
    }
    return nap.signal.aborted;
  }
}
