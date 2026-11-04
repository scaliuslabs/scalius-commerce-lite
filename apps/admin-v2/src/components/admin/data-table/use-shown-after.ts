import { createContext, useContext, useEffect, useRef, useState } from "react";

/** A wait shorter than this shows no loading sign at all (L3). */
export const LOADING_SIGN_DELAY_MS = 300;
/** Once shown, a loading sign stays at least this long, so it never flickers (L3). */
export const LOADING_SIGN_MIN_MS = 300;

/**
 * One wait that several components show in turn: a lazy part's code, then
 * the data it reads (`LazyPart`). The delay counts from the span's start and
 * a sign one of them showed stays shown in the next, so the merchant sees one
 * wait, never a skeleton, a gap and a skeleton again. It ends with the first
 * wait that finishes; later waits time themselves.
 */
export interface LoadingSpan {
  start: number;
  shownAt: number | null;
  ended: boolean;
}

export const newLoadingSpan = (): LoadingSpan => ({ start: Date.now(), shownAt: null, ended: false });
export const LoadingSpanContext = createContext<LoadingSpan | null>(null);

/**
 * True while `active` has lasted `delay` ms, and then for at least `min` ms
 * once it turned true: a skeleton or progress line for a slow wait only,
 * never a flash for a fast one. Inside a `LoadingSpan` the wait is the span's.
 */
export function useShownAfter(active: boolean, delay = LOADING_SIGN_DELAY_MS, min = LOADING_SIGN_MIN_MS): boolean {
  const context = useContext(LoadingSpanContext);
  const span = context && !context.ended ? context : null;
  const [shown, setShown] = useState(() => span?.shownAt != null);
  const shownAt = useRef(span?.shownAt ?? 0);
  const waited = useRef(false);

  useEffect(() => {
    const live = context && !context.ended ? context : null;
    if (active) waited.current = true;
    if (active && !shown) {
      const timer = window.setTimeout(() => {
        shownAt.current = Date.now();
        if (live && !live.ended) live.shownAt = shownAt.current;
        setShown(true);
      }, live ? Math.max(0, live.start + delay - Date.now()) : delay);
      return () => window.clearTimeout(timer);
    }
    if (!active && waited.current && context) context.ended = true;
    if (!active && shown) {
      const left = shownAt.current + min - Date.now();
      const hide = () => {
        if (context && waited.current) context.ended = true;
        setShown(false);
      };
      if (left <= 0) {
        hide();
        return;
      }
      const timer = window.setTimeout(hide, left);
      return () => window.clearTimeout(timer);
    }
  }, [active, shown, delay, min, context]);

  return shown;
}
