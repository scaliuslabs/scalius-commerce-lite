import { createContext, isValidElement, Suspense, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

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
 * The wait of each lazy part's code, by the lazy component (one module-level
 * object per part). A card mounted again while that code still loads (its
 * form remounting under it) carries on the same wait instead of starting a
 * new one, which would hide its skeleton for another 300 ms.
 */
const spans = new WeakMap<object, LoadingSpan>();

function spanFor(children: ReactNode): LoadingSpan {
  const type = isValidElement(children) && typeof children.type === "object" && children.type !== null ? children.type : null;
  const known = type ? spans.get(type) : undefined;
  if (known && !known.ended) return known;
  const span = { start: Date.now() };
  if (type) spans.set(type, span);
  return span;
}

/**
 * The fallback while the code loads: hidden by CSS (`animate-wait-sign`)
 * until its wait has lasted 300 ms, counted from the wait's start, so a
 * fallback mounted again mid-wait (the part suspending once more, the card
 * remounting) keeps a sign already shown on screen. After the part's first
 * commit a new suspension is a wait of its own.
 */
function Waiting({ span, className, children }: { span: LoadingSpan; className?: string; children: ReactNode }) {
  const [delay] = useState(() => (span.ended ? 300 : Math.max(0, 300 - (Date.now() - span.start))));
  return <div className={`animate-wait-sign ${className ?? ""}`} style={{ "--wait-sign-delay": `${delay}ms` } as CSSProperties}>{children}</div>;
}

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
  const [span] = useState<LoadingSpan>(() => spanFor(children));
  return (
    <SpanContext.Provider value={span}>
      <Suspense fallback={<Waiting span={span} className={className}>{fallback}</Waiting>}>
        <Arrived span={span} fallback={fallback}>{children}</Arrived>
      </Suspense>
    </SpanContext.Provider>
  );
}
