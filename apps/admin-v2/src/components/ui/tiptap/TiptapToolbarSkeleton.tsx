import { cn } from "@scalius/shared/utils";

interface TiptapToolbarSkeletonProps {
  compact?: boolean;
  isFullscreen?: boolean;
}

const GROUPS = [3, 4, 4, 3, 3, 1, 2];

export function TiptapToolbarSkeleton({
  compact = false,
  isFullscreen = false,
}: TiptapToolbarSkeletonProps) {
  const buttonSize = compact ? "h-7 w-7" : "h-9 w-9";
  const gapSize = compact ? "gap-0.5" : "gap-1";
  const padding = compact ? "p-0.5" : "p-1";

  return (
    <div
      aria-hidden="true"
      className={cn(
        "border border-input rounded-t-md bg-background flex flex-wrap items-center",
        isFullscreen ? "justify-center" : "justify-between",
        padding,
        gapSize,
      )}
    >
      <div className={cn("flex flex-wrap items-center", gapSize)}>
        {GROUPS.map((count, groupIndex) => (
          <div key={groupIndex} className={cn("flex items-center", gapSize)}>
            {groupIndex > 0 ? <div className="w-px h-6 bg-border mx-1" /> : null}
            {Array.from({ length: count }).map((_, itemIndex) => (
              <span
                key={itemIndex}
                className={cn(
                  buttonSize,
                  "inline-flex shrink-0 rounded-md bg-muted/35",
                )}
              />
            ))}
          </div>
        ))}
      </div>
      {!isFullscreen ? (
        <span className={cn(buttonSize, "inline-flex shrink-0 rounded-md bg-muted/35")} />
      ) : null}
    </div>
  );
}
