/** Batches the daemon's refreshes: requests for the same delay in the meantime share one run. */

/** Calls `run` `ms` after the first call for that delay; calls with the same delay in between share it. */
export function coalesce(run: () => void) {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  return (ms: number) => {
    if (timers.has(ms)) return;
    timers.set(
      ms,
      setTimeout(() => {
        timers.delete(ms);
        run();
      }, ms),
    );
  };
}
