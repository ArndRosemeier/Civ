/** Presentation clock: runs only while a visible map object needs animation. */
export const createMapAnimation = (host: {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
  paint(step: number): void;
}): { sync(active: boolean): void } => {
  let active = false;
  let pending: number | undefined;
  let lastPaint: number | undefined;
  let step = 0;
  const schedule = (): void => {
    if (active && pending === undefined) pending = host.request(tick);
  };
  const tick: FrameRequestCallback = (time) => {
    pending = undefined;
    if (!active) return;
    // Ten frames per second are sufficient for the work cycle; the game never sees this clock.
    if (lastPaint === undefined || time - lastPaint >= 100) {
      lastPaint = time;
      step = (step + 1) % 6;
      host.paint(step);
    }
    schedule();
  };
  return {
    sync(next) {
      active = next;
      schedule();
      if (!active) {
        if (pending !== undefined) host.cancel(pending);
        pending = undefined;
        lastPaint = undefined;
        step = 0;
      }
    },
  };
};
