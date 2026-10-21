import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { ModalInertBackground } from "./overlay";

const Sheet = SheetPrimitive.Root;

const SheetTrigger = SheetPrimitive.Trigger;

const SheetClose = SheetPrimitive.Close;

/**
 * Side sheets open under the shell's top bar (`--app-bar-height`, global.css),
 * and so does their backdrop: overlays never cover the top bar (DESIGN Overlays).
 */
const sheetOverlayClassName =
  "fixed inset-x-0 bottom-0 top-(--app-bar-height) z-50 bg-overlay data-[state=closed]:pointer-events-none data-[state=closed]:invisible";

interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> {
  side?: "left" | "right";
}

/**
 * DESIGN O4: a side panel under the top bar. Compose it as `flex flex-col`
 * with `SheetHeader` (title, description and the close button), a scrolling
 * body (`min-h-0 flex-1 overflow-y-auto`) and an optional `SheetFooter`.
 */
const SheetContent = React.forwardRef<React.ComponentRef<typeof SheetPrimitive.Content>, SheetContentProps>(
  ({ side = "right", className, children, ...props }, ref) => (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className={sheetOverlayClassName} />
      <SheetPrimitive.Content
        ref={ref}
        data-slot="sheet-content"
        className={cn(
          "fixed bottom-0 top-(--app-bar-height) z-50 w-full bg-card text-card-foreground shadow-modal focus:outline-none data-[state=closed]:pointer-events-none data-[state=closed]:invisible sm:max-w-md",
          side === "right" ? "inset-e-0" : "inset-s-0",
          className,
        )}
        {...props}
      >
        <ModalInertBackground />
        {children}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  ),
);
SheetContent.displayName = SheetPrimitive.Content.displayName;

interface SheetHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Disables the close button while a save is in flight. */
  closeDisabled?: boolean;
}

/**
 * The sheet's bordered header bar: the title (and description) at the start,
 * the one close button on the title line at the end. Every sheet closes the same way.
 */
const SheetHeader = ({ className, children, closeDisabled, ...props }: SheetHeaderProps) => {
  const t = useMessages(resourceMessages);
  return (
    <div data-slot="sheet-header" className={cn("flex shrink-0 items-start gap-2 border-b p-4", className)} {...props}>
      <div className="flex min-w-0 flex-1 flex-col gap-1 text-start">{children}</div>
      <div className="flex h-lh shrink-0 items-center text-heading-md">
        <SheetPrimitive.Close
          disabled={closeDisabled}
          className="-me-2 flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground active:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 sm:size-8"
        >
          <X className="size-4" aria-hidden />
          <span className="sr-only">{t("close")}</span>
        </SheetPrimitive.Close>
      </div>
    </div>
  );
};
SheetHeader.displayName = "SheetHeader";

/**
 * The sheet's action bar: a bordered bar under a scrolling body, so the
 * actions never scroll away. Put the body in a `min-h-0 flex-1 overflow-y-auto`
 * box inside a `flex flex-col` SheetContent.
 */
const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="sheet-footer"
    className={cn("flex shrink-0 flex-col-reverse gap-2 border-t bg-card p-4 max-sm:pb-safe sm:flex-row sm:justify-end", className)}
    {...props}
  />
);
SheetFooter.displayName = "SheetFooter";

const SheetTitle = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => <SheetPrimitive.Title ref={ref} className={cn("text-heading-md", className)} {...props} />);
SheetTitle.displayName = SheetPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ComponentRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description ref={ref} className={cn("text-body text-muted-foreground", className)} {...props} />
));
SheetDescription.displayName = SheetPrimitive.Description.displayName;

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription };
