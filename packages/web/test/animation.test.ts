import { describe, expect, it } from 'vitest';
import { createMapAnimation } from '../src/animation.js';

const harness = () => {
  const queue = new Map<number, FrameRequestCallback>();
  const painted: number[] = [];
  let next = 0;
  const clock = createMapAnimation({
    request(callback) {
      const id = ++next;
      queue.set(id, callback);
      return id;
    },
    cancel(id) {
      queue.delete(id);
    },
    paint(step) {
      painted.push(step);
      clock.sync(true);
    },
  });
  return {
    clock,
    queue,
    painted,
    frame(time: number) {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const callback of callbacks) callback(time);
    },
  };
};

describe('map animation lifecycle', () => {
  it('does no work while idle and keeps a single frame request when drawing re-enters sync', () => {
    const h = harness();
    h.clock.sync(false);
    expect(h.queue.size).toBe(0);
    h.clock.sync(true);
    h.clock.sync(true);
    h.frame(0);
    expect(h.painted).toEqual([1]);
    expect(h.queue.size).toBe(1);
    h.clock.sync(false);
    expect(h.queue.size).toBe(0);
    h.frame(1000);
    expect(h.painted).toEqual([1]);
  });

  it('limits painting to ten frames per second and restarts after suspension', () => {
    const h = harness();
    h.clock.sync(true);
    h.frame(0);
    h.frame(16);
    h.frame(99);
    h.frame(100);
    expect(h.painted).toEqual([1, 2]);
    h.clock.sync(false);
    h.clock.sync(true);
    h.frame(110);
    expect(h.painted).toEqual([1, 2, 1]);
  });
});
