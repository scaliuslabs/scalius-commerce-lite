import { cn } from "@scalius/shared/utils";
import { Skeleton } from "~/components/ui/skeleton";

export interface SkeletonPageProps {
  /** Number of annotated sections to outline. Default: 2. */
  sections?: number;
  /** Include the page header placeholder. Default: true. */
  showHeader?: boolean;
  /** Field rows drawn inside each section card. Default: 3. */
  rowsPerSection?: number;
  /** Announced while loading. Default: "Loading". */
  label?: string;
  className?: string;
}

/**
 * Loading shape for a settings page: a header block plus annotated sections.
 * Content areas use skeletons, never spinners, so the layout does not jump.
 */
export function SkeletonPage({
  sections = 2,
  showHeader = true,
  rowsPerSection = 3,
  label = "Loading",
  className,
}: SkeletonPageProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      data-testid="skeleton-page"
      className={cn("space-y-6", className)}
    >
      <span className="sr-only">{label}</span>
      {showHeader ? (
        <div className="space-y-2" data-testid="skeleton-page-header">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
      ) : null}
      {Array.from({ length: Math.max(0, sections) }, (_, index) => (
        <div
          key={index}
          data-testid="skeleton-page-section"
          className="grid gap-3 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:gap-8"
        >
          <div className="space-y-2 lg:pt-1">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-52 max-w-full" />
          </div>
          <div className="space-y-4 rounded-lg border border-border bg-card p-4 sm:p-6">
            {Array.from({ length: Math.max(1, rowsPerSection) }, (_, row) => (
              <div key={row} className="space-y-2">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default SkeletonPage;
