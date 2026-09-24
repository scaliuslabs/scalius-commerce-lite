import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";

import { cn } from "@scalius/shared/utils";
import { overlayClassName } from "./dialog";

const Sheet = SheetPrimitive.Root;

const SheetTrigger = SheetPrimitive.Trigger;

const SheetClose = SheetPrimitive.Close;

interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> {
  side?: "top" | "bottom" | "left" | "right";
}

const SheetContent = React.forwardRef<React.ComponentRef<typeof SheetPrimitive.Content>, SheetContentProps>(
  ({ side = "right", className, children, ...props }, ref) => (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className={overlayClassName} />
      <SheetPrimitive.Content
        ref={ref}
        className={cn(
          "fixed z-50 bg-card text-card-foreground shadow-modal focus:outline-none data-[state=closed]:pointer-events-none data-[state=closed]:invisible",
          side === "right" && "inset-y-0 right-0 h-full w-full sm:max-w-md",
          side === "left" && "inset-y-0 left-0 h-full w-full sm:max-w-md",
          side === "top" && "inset-x-0 top-0",
          side === "bottom" && "inset-x-0 bottom-0 rounded-t-2xl",
          className,
        )}
        {...props}
      >
        {children}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  ),
);
SheetContent.displayName = SheetPrimitive.Content.displayName;

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-1 text-left", className)} {...props} />
);
SheetHeader.displayName = "SheetHeader";

/**
 * The sheet's action bar: a bordered bar under a scrolling body, so the
 * actions never scroll away. Put the body in a `min-h-0 flex-1 overflow-y-auto`
 * box inside a `flex flex-col` SheetContent.
 */
const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    data-slot="sheet-footer"
    className={cn("flex shrink-0 flex-col-reverse gap-2 border-t bg-card px-6 py-4 max-sm:pb-safe sm:flex-row sm:justify-end", className)}
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
