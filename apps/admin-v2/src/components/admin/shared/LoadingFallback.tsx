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
