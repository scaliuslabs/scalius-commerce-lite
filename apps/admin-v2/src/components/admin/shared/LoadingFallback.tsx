import { cn } from "@scalius/shared/utils";

interface LoadingFallbackProps {
  /** Height class, e.g. "h-48", "h-96", "h-[400px]" */
  height?: string;
  /** Additional className */
  className?: string;
}

/**
 * Standard Suspense fallback — animated pulse placeholder.
 * Use as: <Suspense fallback={<LoadingFallback height="h-48" />}>
 */
export function LoadingFallback({ height = "h-48", className }: LoadingFallbackProps) {
  return (
    <div className={cn("animate-pulse rounded-lg bg-muted", height, className)} />
  );
}

/** Stable page-shaped fallback for a cold lazy surface. */
export function PageLoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-4" role="status" aria-label="Loading page">
      <div className="flex items-center justify-between gap-4">
        <div className="h-7 w-48 rounded-md bg-muted" />
        <div className="h-9 w-28 rounded-md bg-muted" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="h-24 rounded-lg bg-muted" />
        <div className="h-24 rounded-lg bg-muted" />
        <div className="h-24 rounded-lg bg-muted" />
      </div>
      <div className="h-64 rounded-lg bg-muted" />
      <span className="sr-only">Loading page</span>
    </div>
  );
}

/** Stable panel-shaped fallback for a cold lazy settings editor. */
export function PanelLoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-4 py-4" role="status" aria-label="Loading settings">
      <div className="h-6 w-44 rounded-md bg-muted" />
      <div className="h-4 w-2/3 rounded bg-muted" />
      <div className="space-y-3 rounded-lg border p-4">
        <div className="h-10 rounded-md bg-muted" />
        <div className="h-10 rounded-md bg-muted" />
        <div className="h-10 w-1/3 rounded-md bg-muted" />
      </div>
      <span className="sr-only">Loading settings</span>
    </div>
  );
}

/**
 * Card skeleton for dashboard/settings cards.
 */
export function CardSkeleton({ count = 1 }: { count?: number }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="h-32 animate-pulse rounded-lg bg-muted" />
      ))}
    </div>
  );
}
