import { X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";

import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";

export type EditorSheetWidth = "sm" | "md" | "lg";

/** Widths are named, not measured, so every editor in the dashboard matches. */
export const EDITOR_SHEET_WIDTHS: Record<EditorSheetWidth, string> = {
  sm: "sm:max-w-md",
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
};

export interface EditorSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names the sheet for assistive tech; Radix points `aria-labelledby` at it. */
  title: string;
  /** One line saying what the sheet does or what saving will change. */
  description?: ReactNode;
  /** Default: "md". */
  width?: EditorSheetWidth;
  /** Default: "right". */
  side?: "right" | "left";
  /**
   * Pinned action row under the scrolling body. Put Cancel first and the
   * primary action last; a `type="submit"` button here runs `onSubmit`.
   */
  footer?: ReactNode;
  /**
   * Wraps the body and footer in a form: Enter submits, and the footer's submit
   * button saves. Omit for read-only sheets (a preview, a history list).
   */
  onSubmit?: () => void;
  /** Extra header controls shown left of the close button. */
  headerActions?: ReactNode;
  /** Default: "Close". */
  closeLabel?: string;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/**
 * The dashboard's side editor: a titled header with a close button, one
 * scrolling body, and a pinned footer for the actions. Radix owns the focus
 * trap, the Escape key, and the overlay; everything else is layout so no two
 * editors drift apart.
 *
 * Sheets are for editing one record beside the list that opened them. A page
 * with its own URL still belongs on a route, and a yes/no question belongs in
 * an `AlertDialog`.
 */
export function EditorSheet({
  open,
  onOpenChange,
  title,
  description,
  width = "md",
  side = "right",
  footer,
  onSubmit,
  headerActions,
  closeLabel = "Close",
  children,
  className,
  bodyClassName,
}: EditorSheetProps) {
  const body = (
    <>
      <div
        data-testid="editor-sheet-body"
        className={cn("min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6", bodyClassName)}
      >
        {children}
      </div>
      {footer ? (
        <div
          data-testid="editor-sheet-footer"
          className="flex shrink-0 flex-col-reverse gap-2 border-t border-border bg-background p-4 sm:flex-row sm:justify-end sm:p-6"
        >
          {footer}
        </div>
      ) : null}
    </>
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit?.();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={side}
        data-testid="editor-sheet"
        // Radix points `aria-describedby` at its description; without one the
        // attribute would dangle.
        {...(description ? {} : { "aria-describedby": undefined })}
        className={cn("flex flex-col gap-0 p-0", EDITOR_SHEET_WIDTHS[width], className)}
      >
        <SheetHeader className="shrink-0 space-y-0 border-b border-border p-4 text-left sm:p-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <SheetTitle>{title}</SheetTitle>
              {description ? <SheetDescription>{description}</SheetDescription> : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {headerActions}
              <SheetClose asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={closeLabel}
                  data-testid="editor-sheet-close"
                  className="-mr-1 -mt-1 h-11 w-11 sm:h-9 sm:w-9"
                >
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              </SheetClose>
            </div>
          </div>
        </SheetHeader>

        {onSubmit ? (
          <form method="post" className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
            {body}
          </form>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">{body}</div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default EditorSheet;
