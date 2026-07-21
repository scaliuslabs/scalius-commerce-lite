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
        "border border-input rounded-t-md bg-background flex flex-wrap items-center text-muted-foreground/70",
        isFullscreen ? "justify-center" : "justify-between",
        padding,
        gapSize,
      )}
    >
      <div className={cn("flex flex-wrap items-center", gapSize)}>
        {TOOLBAR_GROUPS.map((group, groupIndex) => (
          <div key={groupIndex} className={cn("flex items-center", gapSize)}>
            {groupIndex > 0 ? <div className="w-px h-6 bg-border mx-1" /> : null}
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
