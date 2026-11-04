import { Suspense, useState, type ReactNode } from "react";
import { LoadingSpanContext, newLoadingSpan, useShownAfter } from "../data-table/use-shown-after";

/** The skeleton for a wait: kept invisible (holding its space) for the first 300 ms, then shown. */
function Waiting({ fallback }: { fallback: ReactNode }) {
  const shown = useShownAfter(true);
  return shown ? fallback : <div className="invisible" aria-hidden="true">{fallback}</div>;
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
  const [span] = useState(newLoadingSpan);
  return (
    <LoadingSpanContext.Provider value={span}>
      <Suspense fallback={<Waiting fallback={fallback} />}>
        <Arrived fallback={fallback}>{children}</Arrived>
      </Suspense>
    </LoadingSpanContext.Provider>
  );
}
