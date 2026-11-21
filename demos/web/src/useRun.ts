import { useEffect, useState } from "react";

/** The settled outcome of the run identified by `key`. */
type Settled = { key: string; failed: string | null };

/**
 * Runs `task` whenever `key` changes and keeps only the result of the latest key: a slow older run is cancelled in
 * the cleanup and, even if its promise settles later, never replaces a newer one. `value` is the last result that
 * arrived (so a view stays on screen while the next run is pending; it carries its own inputs, so it is always
 * coherent), `busy` is true until the run of the current key settles and `failed` holds the message of a rejection
 * of the current key. `task` is read from the render in which `key` changed, so `key` must name everything it uses.
 */
export function useRun<T>(key: string, task: () => Promise<T>): { value: T | null; busy: boolean; failed: string | null } {
  const [value, setValue] = useState<T | null>(null);
  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    let cancelled = false;
    task().then(
      (v) => {
        if (cancelled) return;
        setValue(v);
        setSettled({ key, failed: null });
      },
      (e: unknown) => {
        if (!cancelled) setSettled({ key, failed: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
    // `key` names everything `task` reads, so it is the only dependency.
  }, [key]);

  const current = settled?.key === key ? settled : null;
  return { value, busy: current === null, failed: current?.failed ?? null };
}
