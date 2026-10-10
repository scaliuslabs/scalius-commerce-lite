import { useEffect, useRef, useState } from "react";

/** A wait shorter than this shows no loading sign at all (L3). */
export const LOADING_SIGN_DELAY_MS = 300;
/** Once shown, a loading sign stays at least this long, so it never flickers (L3). */
export const LOADING_SIGN_MIN_MS = 300;

/**
 * True while `active` has lasted `delay` ms, and then for at least `min` ms
 * once it turned true: a skeleton or progress line for a slow wait only,
 * never a flash for a fast one.
 */
export function useShownAfter(active: boolean, delay = LOADING_SIGN_DELAY_MS, min = LOADING_SIGN_MIN_MS): boolean {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);

  useEffect(() => {
    if (active && !shown) {
      const timer = window.setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, delay);
      return () => window.clearTimeout(timer);
    }
    if (!active && shown) {
      const left = shownAt.current + min - Date.now();
      if (left <= 0) {
        setShown(false);
        return;
      }
      const timer = window.setTimeout(() => setShown(false), left);
      return () => window.clearTimeout(timer);
    }
  }, [active, shown, delay, min]);

  return shown;
}
