import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";

import { cn } from "@scalius/shared/utils";
import { overlayClassName } from "./dialog";

interface SidebarMobileSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "left" | "right";
  children: React.ReactNode;
}

export function SidebarMobileSheet({ open, onOpenChange, side = "left", children }: SidebarMobileSheetProps) {
  return (
    <SheetPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <SheetPrimitive.Portal>
        <SheetPrimitive.Overlay className={overlayClassName} />
        <SheetPrimitive.Content
          data-sidebar="sidebar"
          data-mobile="true"
          className={cn(
            "fixed inset-y-0 z-50 flex w-60 max-w-[calc(100vw-2rem)] flex-col bg-sidebar text-sidebar-foreground shadow-modal focus:outline-none data-[state=closed]:pointer-events-none data-[state=closed]:invisible",
            side === "left" ? "left-0" : "right-0",
          )}
        >
          <SheetPrimitive.Title className="sr-only">Sidebar</SheetPrimitive.Title>
          <SheetPrimitive.Description className="sr-only">Navigation sidebar</SheetPrimitive.Description>
          {children}
        </SheetPrimitive.Content>
      </SheetPrimitive.Portal>
    </SheetPrimitive.Root>
  );
}
