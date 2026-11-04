import { createContext, Suspense, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A `LazyPart`'s wait: its code, then the data its part reads at once. A
 * sign shown while the code loaded carries on into the part's own data
 * wait, timed from this start, so the merchant sees one wait, never a
 * skeleton, a gap and a skeleton again. It ends when the part first commits,
 * waiting or not: anything that starts waiting later times itself.
 */
interface LoadingSpan {
  start: number;
  ended?: boolean;
}

const SpanContext = createContext<LoadingSpan | null>(null);

/**
 * True once `active` has lasted `delay` ms (300: a shorter wait shows no
 * loading sign at all), and then for at least `min` ms (300: a shown sign
 * never flickers) (L3). A hook that mounts while its `LazyPart` waits counts
 * its first wait from the part's start.
 */
export function useShownAfter(active: boolean, delay = 300, min = 300): boolean {
  const span = useContext(SpanContext);
  const [from] = useState(() => (span && !span.ended ? span.start : 0));
  // Mounting after the part's sign appeared: it is still showing.
  const [shown, setShown] = useState(() => from > 0 && Date.now() - from >= delay);
  const shownAt = useRef(from + delay);
  const waitFrom = useRef(from);

  useEffect(() => {
    if (active === shown) {
      if (!active) waitFrom.current = 0;
      return;
    }
    const left = active ? (waitFrom.current || Date.now()) + delay - Date.now() : shownAt.current + min - Date.now();
    const settle = () => {
      if (active) shownAt.current = Date.now();
      else waitFrom.current = 0;
      setShown(active);
    };
    if (!active && left <= 0) return settle();
    const timer = window.setTimeout(settle, Math.max(0, left));
    return () => window.clearTimeout(timer);
  }, [active, shown, delay, min]);

  return shown;
}

/** Once the code is here: a skeleton already shown stays its 300 ms, then the part, whose own wait carries it on. */
function Arrived({ span, fallback, children }: { span: LoadingSpan; fallback: ReactNode; children: ReactNode }) {
  const held = useShownAfter(false);
  useEffect(() => {
    if (!held) span.ended = true;
  }, [held, span]);
  return held ? fallback : children;
}

/**
 * A part whose code loads lazily, with the shared loading rule (L3) over the
 * whole wait: no skeleton for the first 300 ms (CSS hides the fallback until then,
 * `animate-wait-sign`), then one that stays at least 300 ms, carried on by
 * the part's own data skeleton (`useShownAfter` inside it) without a gap. Use
 * it in place of `<Suspense fallback={<Skeleton />}>`; `className` places the
 * waiting wrapper where the skeleton's own box would sit (a grid span, a width).
 */
export function LazyPart({ fallback, className, children }: { fallback: ReactNode; className?: string; children: ReactNode }) {
  const [span] = useState<LoadingSpan>(() => ({ start: Date.now() }));
  return (
    <SpanContext.Provider value={span}>
      <Suspense fallback={<div className={`animate-wait-sign ${className ?? ""}`}>{fallback}</div>}>
        <Arrived span={span} fallback={fallback}>{children}</Arrived>
      </Suspense>
    </SpanContext.Provider>
  );
}
