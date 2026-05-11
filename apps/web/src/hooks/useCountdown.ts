import { useEffect, useState } from 'react';

/**
 * Returns the number of whole seconds remaining until `targetDate`,
 * ticking down every second. Returns `null` when no target is set,
 * and `0` once the target has passed.
 */
export function useCountdown(targetDate: string | undefined): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!targetDate) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale countdown when target removed
      setRemaining(null);
      return;
    }
    let interval: ReturnType<typeof setInterval> | undefined;
    const update = () => {
      const diff = new Date(targetDate).getTime() - Date.now();
      const value = Math.max(0, Math.floor(diff / 1000));
      setRemaining(value);
      if (value <= 0 && interval) {
        clearInterval(interval);
        interval = undefined;
      }
    };
    update();
    interval = setInterval(update, 1000);
    return () => {
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [targetDate]);
  return remaining;
}

/** Format a countdown in seconds to a human-readable string. */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) {
    return 'Resuming soon';
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}
