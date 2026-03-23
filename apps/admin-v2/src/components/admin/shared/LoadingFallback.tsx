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

/**
 * Full-page loading spinner for route transitions.
 */
export function PageLoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
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
