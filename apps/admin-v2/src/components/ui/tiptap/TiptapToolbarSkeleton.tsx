import { cn } from "@scalius/shared/utils";
import { Bold, Italic, Underline, Link, List, ListOrdered, Maximize, Redo, Undo, Pilcrow, ChevronDown, MoreHorizontal, Plus } from "lucide-react";
import { TOOLBAR_ROW, TOOLBAR_BUTTON, TOOLBAR_STYLE, TOOLBAR_WIDE, TOOLBAR_NARROW, TOOLBAR_INSERT } from "./tiptap-toolbar-layout";

interface TiptapToolbarSkeletonProps {
  compact?: boolean;
  isFullscreen?: boolean;
}

export function TiptapToolbarSkeleton({ isFullscreen = false }: TiptapToolbarSkeletonProps) {
  const slot = "inline-flex items-center justify-center rounded-lg [&>svg]:size-4";
  return (
    <div aria-hidden="true" className={cn("@container min-w-0 shrink-0 bg-card text-muted-foreground", isFullscreen && "mx-auto w-full max-w-2xl sm:px-4")}>
      <div className={TOOLBAR_ROW}>
        <span className={cn(TOOLBAR_STYLE, slot)}><Pilcrow /><ChevronDown /></span>
        <span className="mx-1 h-5 w-px shrink-0 bg-border" />
        <span className={cn(TOOLBAR_BUTTON, slot)}><Bold /></span>
        <span className={cn(TOOLBAR_BUTTON, slot)}><Italic /></span>
        <span className={TOOLBAR_WIDE}><span className={cn(TOOLBAR_BUTTON, slot)}><Underline /></span></span>
        <span className={cn(TOOLBAR_BUTTON, slot)}><Link /></span>
        <span className={cn(TOOLBAR_WIDE, "items-center gap-0.5")}>
          <span className={cn(TOOLBAR_BUTTON, slot)}><List /></span>
          <span className={cn(TOOLBAR_BUTTON, slot)}><ListOrdered /></span>
          <span className={cn(TOOLBAR_INSERT, slot)}><Plus /></span>
        </span>
        <span className={TOOLBAR_NARROW}><span className={cn(TOOLBAR_BUTTON, slot)}><MoreHorizontal /></span></span>
        <span className={cn(TOOLBAR_WIDE, "ms-auto items-center gap-0.5")}>
          <span className={cn(TOOLBAR_BUTTON, slot)}><Undo /></span>
          <span className={cn(TOOLBAR_BUTTON, slot)}><Redo /></span>
        </span>
        {!isFullscreen && <span className={cn(TOOLBAR_BUTTON, slot, "ms-auto")}><Maximize /></span>}
      </div>
    </div>
  );
}
