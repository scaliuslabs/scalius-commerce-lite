import { cn } from "@scalius/shared/utils";

interface TiptapToolbarSkeletonProps {
  compact?: boolean;
  isFullscreen?: boolean;
}

export function TiptapToolbarSkeleton({
  compact = false,
  isFullscreen = false,
}: TiptapToolbarSkeletonProps) {
  const railHeight = compact ? "h-7" : "h-9";
  const primaryWidth = compact ? "w-28" : "w-36";
  const secondaryWidth = compact ? "w-12" : "w-16";
  const padding = compact ? "p-0.5" : "p-1";

  return (
    <div
      aria-hidden="true"
      className={cn(
        "rounded-t-md border border-input bg-background",
        padding,
      )}
    >
      <div
        className={cn(
          "flex items-center gap-2 px-2",
          railHeight,
          isFullscreen ? "justify-center" : "",
        )}
      >
        <span className={cn("h-1.5 rounded-full bg-muted", primaryWidth)} />
        <span className={cn("h-1.5 rounded-full bg-muted/80", secondaryWidth)} />
        {!isFullscreen ? (
          <span className="ml-auto h-1.5 w-8 rounded-full bg-muted/70" />
        ) : null}
      </div>
    </div>
  );
}
