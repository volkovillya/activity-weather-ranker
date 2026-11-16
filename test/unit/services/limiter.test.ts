import { describe, expect, it } from '@jest/globals';
import { createUpstreamLimiter } from '../../../src/services/limiter';

// H3a
describe('createUpstreamLimiter', () => {
  it('grants up to the limit and refuses at once beyond it', () => {
    const limiter = createUpstreamLimiter(2);
    expect(limiter.tryAcquire()).toEqual(expect.any(Function));
    expect(limiter.tryAcquire()).toEqual(expect.any(Function));
    expect(limiter.tryAcquire()).toBeNull();
  });

  it('frees exactly one permit per release', () => {
    const limiter = createUpstreamLimiter(2);
    const first = limiter.tryAcquire()!;
    limiter.tryAcquire();

    first();
    expect(limiter.tryAcquire()).not.toBeNull();
    expect(limiter.tryAcquire()).toBeNull();
  });

  it('ignores a second release of the same permit', () => {
    const limiter = createUpstreamLimiter(1);
    const release = limiter.tryAcquire()!;
    release();
    release();

    expect(limiter.tryAcquire()).not.toBeNull();
    expect(limiter.tryAcquire()).toBeNull(); // the double release did not add a permit
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects a limit of %p', (max) => {
    expect(() => createUpstreamLimiter(max)).toThrow(RangeError);
  });
});
