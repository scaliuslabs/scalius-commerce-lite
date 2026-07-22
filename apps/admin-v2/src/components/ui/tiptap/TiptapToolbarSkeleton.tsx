import { cn } from "@scalius/shared/utils";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  FolderOpen,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Maximize,
  Redo,
  Table,
  TextQuote,
  Underline as UnderlineIcon,
  Undo,
  Video as VideoIcon,
  type LucideIcon,
} from "lucide-react";

interface TiptapToolbarSkeletonProps {
  compact?: boolean;
  isFullscreen?: boolean;
}

const TOOLBAR_GROUPS: LucideIcon[][] = [
  [Bold, Italic, UnderlineIcon],
  [LinkIcon, ImageIcon, FolderOpen, VideoIcon],
  [AlignLeft, AlignCenter, AlignRight, AlignJustify],
  [Heading1, Heading2, Heading3],
  [List, ListOrdered, TextQuote],
  [Table],
  [Undo, Redo],
];

export function TiptapToolbarSkeleton({
  compact = false,
  isFullscreen = false,
}: TiptapToolbarSkeletonProps) {
  const buttonSize = compact
    ? "h-11 w-11 sm:h-7 sm:w-7"
    : "h-11 w-11 sm:h-9 sm:w-9";
  const iconSize = compact ? "h-4 w-4 sm:h-3 sm:w-3" : "h-4 w-4";
  const gapSize = compact ? "gap-0.5" : "gap-1";
  const padding = compact ? "p-0.5" : "p-1";

  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex items-center overflow-hidden rounded-t-md border border-input bg-background text-muted-foreground/70",
        padding,
        gapSize,
      )}
    >
      <div
        className={cn(
          "min-w-0 overflow-x-auto overscroll-x-contain scrollbar-hide",
          isFullscreen ? "mx-auto w-fit max-w-full" : "flex-1",
        )}
      >
        <div className={cn("flex min-w-max items-center", gapSize)}>
          {TOOLBAR_GROUPS.map((group, groupIndex) => (
            <div key={groupIndex} className={cn("flex items-center", gapSize)}>
              {groupIndex > 0 ? <div className="mx-1 h-6 w-px bg-border" /> : null}
              {group.map((Icon, itemIndex) => (
                <span
                  key={itemIndex}
                  className={cn(
                    buttonSize,
                    "inline-flex shrink-0 items-center justify-center rounded-md",
                  )}
                >
                  <Icon className={iconSize} strokeWidth={2} />
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
      {!isFullscreen ? (
        <span
          className={cn(
            buttonSize,
            "inline-flex shrink-0 items-center justify-center rounded-md",
          )}
        >
          <Maximize className={iconSize} strokeWidth={2} />
        </span>
      ) : null}
    </div>
  );
}
