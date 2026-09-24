import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogClose = DialogPrimitive.Close;

/** Overlay and panel classes shared with AlertDialog. State never depends on animation. */
export const overlayClassName =
  "fixed inset-0 z-50 bg-overlay data-[state=closed]:pointer-events-none data-[state=closed]:invisible";
/** Centred from `sm` up; a bottom sheet on phones, within thumb reach. */
export const modalClassName =
  "fixed inset-x-0 bottom-0 z-50 grid max-h-[calc(100dvh-1rem)] w-full gap-4 overflow-y-auto rounded-t-2xl bg-card p-5 max-sm:pb-safe text-card-foreground shadow-modal data-[state=closed]:pointer-events-none data-[state=closed]:invisible sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl";

/**
 * Command palette (global search): drops from under the top bar, 640px wide,
 * 12px radius; on phones it pins to the top because the keyboard owns the bottom.
 */
const paletteClassName =
  "fixed inset-x-0 top-0 z-50 grid max-h-[calc(100dvh-1rem)] w-full overflow-hidden rounded-b-2xl bg-card text-card-foreground shadow-modal data-[state=closed]:pointer-events-none data-[state=closed]:invisible sm:inset-x-auto sm:left-1/2 sm:top-2.5 sm:max-w-160 sm:-translate-x-1/2 sm:rounded-xl";

/** The close button's name in the dashboard language. */
function CloseLabel() {
  const t = useMessages(resourceMessages);
  return <span className="sr-only">{t("close")}</span>;
}

interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  showCloseButton?: boolean;
  /** "palette" is the top-anchored command palette shape (no close button). */
  variant?: "modal" | "palette";
}

const DialogContent = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  ({ className, children, showCloseButton = true, variant = "modal", ...props }, ref) => (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay data-slot="dialog-overlay" className={overlayClassName} />
      <DialogPrimitive.Content ref={ref} data-slot="dialog-content" className={cn(variant === "palette" ? paletteClassName : modalClassName, className)} {...props}>
        {children}
        {showCloseButton && variant === "modal" ? (
          <DialogPrimitive.Close className="absolute right-2 top-2 flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground active:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:right-3 sm:top-3 sm:size-8">
            <X className="size-4" />
            <CloseLabel />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  ),
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-1 pr-8 text-left", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-heading-md", className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-body text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription };
