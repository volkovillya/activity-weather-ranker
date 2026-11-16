/**
 * Admission control for upstream work: at most `max` operations at once in this process, with
 * no waiting queue. A caller either gets a permit at once or is refused at once, so callers can
 * never pile up behind it. It bounds concurrency in one process; it is not a rate limit and does
 * not coordinate instances.
 */
export interface UpstreamLimiter {
  /** A function that releases the permit, or null when every permit is taken. Never waits. */
  tryAcquire(): (() => void) | null;
}

export function createUpstreamLimiter(max: number): UpstreamLimiter {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError('The upstream limit must be a positive integer');
  }
  let active = 0;

  return {
    tryAcquire() {
      if (active >= max) return null;
      active += 1;
      let released = false;
      // Idempotent, so a second call cannot hand out a permit that does not exist.
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
  };
}
