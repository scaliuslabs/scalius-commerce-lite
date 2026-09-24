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
  const buttonSize = compact ? "h-11 w-11 sm:h-7 sm:w-7" : "h-11 w-11 sm:h-9 sm:w-9";

  return (
    <div
      aria-hidden="true"
      className="flex items-center gap-0.5 overflow-hidden bg-card p-1 text-muted-foreground"
    >
      <div
        className={cn(
          // Phones scroll the buttons sideways; wider screens wrap them, so none hide past the edge.
          "min-w-0 overflow-x-auto overscroll-x-contain scrollbar-hide sm:overflow-visible",
          isFullscreen ? "mx-auto w-fit max-w-full" : "flex-1",
        )}
      >
        <div className="flex min-w-max items-center gap-0.5 sm:min-w-0 sm:flex-wrap">
          {TOOLBAR_GROUPS.map((group, groupIndex) => (
            <div key={groupIndex} className="flex items-center gap-0.5">
              {groupIndex > 0 ? <div className="mx-1 h-6 w-px bg-border" /> : null}
              {group.map((Icon, itemIndex) => (
                <span
                  key={itemIndex}
                  className={cn(
                    buttonSize,
                    "inline-flex shrink-0 items-center justify-center rounded-lg",
                  )}
                >
                  <Icon className="size-4" strokeWidth={2} />
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
            "inline-flex shrink-0 items-center justify-center rounded-lg",
          )}
        >
          <Maximize className="size-4" strokeWidth={2} />
        </span>
      ) : null}
    </div>
  );
}
