import { createContext, Suspense, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * One wait that several components show in turn: a lazy part's code, then
 * the data it reads (`LazyPart`). The delay counts from the span's start and
 * a sign one of them showed stays shown in the next, so the merchant sees one
 * wait, never a skeleton, a gap and a skeleton again. The first wait that
 * finishes ends it; later waits time themselves.
 */
interface LoadingSpan {
  start: number;
  /** When a sign showed; 0 while none has. */
  shownAt: number;
  ended?: boolean;
}

const SpanContext = createContext<LoadingSpan | null>(null);

/**
 * True once `active` has lasted `delay` ms (300: a shorter wait shows no
 * loading sign at all), and then for at least `min` ms (300: a shown sign
 * never flickers) (L3). Inside a `LazyPart` the wait is the part's.
 */
export function useShownAfter(active: boolean, delay = 300, min = 300): boolean {
  const context = useContext(SpanContext);
  const span = context?.ended ? null : context;
  const [shown, setShown] = useState(() => Boolean(span?.shownAt));
  const shownAt = useRef(span?.shownAt ?? 0);
  const waited = useRef(false);

  useEffect(() => {
    if (active) waited.current = true;
    else if (waited.current && context) context.ended = true;
    if (active === shown) return;
    const live = context?.ended ? null : context;
    const left = (active ? (live?.start ?? Date.now()) + delay : shownAt.current + min) - Date.now();
    const settle = () => {
      if (active) {
        shownAt.current = Date.now();
        if (live && !live.ended) live.shownAt = shownAt.current;
      }
      setShown(active);
    };
    if (!active && left <= 0) return settle();
    const timer = window.setTimeout(settle, Math.max(0, left));
    return () => window.clearTimeout(timer);
  }, [active, shown, delay, min, context]);

  return shown;
}

/** The skeleton for a wait: kept invisible (holding its space) for the first 300 ms, then shown. */
function Waiting({ fallback }: { fallback: ReactNode }) {
  return useShownAfter(true) ? fallback : <div className="invisible" aria-hidden="true">{fallback}</div>;
}

/** Once the code is here, a skeleton already shown stays its 300 ms; then the part, whose own wait carries it on. */
function Arrived({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  return useShownAfter(false) ? fallback : children;
}

/**
 * A part whose code loads lazily, with the shared loading rule (L3) over the
 * whole wait: no skeleton for the first 300 ms, then one that stays at least
 * 300 ms, carried on by the part's own data skeleton (`useShownAfter` inside
 * it) without a gap. Use it in place of `<Suspense fallback={<Skeleton />}>`.
 */
export function LazyPart({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  const [span] = useState<LoadingSpan>(() => ({ start: Date.now(), shownAt: 0 }));
  return (
    <SpanContext.Provider value={span}>
      <Suspense fallback={<Waiting fallback={fallback} />}>
        <Arrived fallback={fallback}>{children}</Arrived>
      </Suspense>
    </SpanContext.Provider>
  );
}
