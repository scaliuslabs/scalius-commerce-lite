import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@scalius/shared/utils";
import { overlayClassName } from "./dialog";

interface SidebarMobileSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "left" | "right";
  /** The drawer's accessible name, e.g. "Main navigation". */
  label: string;
  closeLabel: string;
  children: React.ReactNode;
}

/**
 * The phone navigation drawer: named, opens on its Close button (Radix skips
 * links when choosing the first focus), and hands focus back to whatever
 * opened it (the top bar's Menu button has no Dialog.Trigger to return to).
 */
export function SidebarMobileSheet({ open, onOpenChange, side = "left", label, closeLabel, children }: SidebarMobileSheetProps) {
  const opener = React.useRef<HTMLElement | null>(null);
  return (
    <SheetPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <SheetPrimitive.Portal>
        <SheetPrimitive.Overlay className={overlayClassName} />
        <SheetPrimitive.Content
          data-sidebar="sidebar"
          data-mobile="true"
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            if (!opener.current?.isConnected) return;
            event.preventDefault();
            opener.current.focus();
          }}
          className={cn(
            "fixed inset-y-0 z-50 flex w-60 max-w-[calc(100vw-2rem)] flex-col bg-sidebar text-sidebar-foreground shadow-modal focus:outline-none data-[state=closed]:pointer-events-none data-[state=closed]:invisible",
            side === "left" ? "left-0" : "right-0",
          )}
        >
          <div className="flex items-center justify-between gap-2 px-2.5 pt-2">
            <SheetPrimitive.Title className="px-2 text-body font-medium">{label}</SheetPrimitive.Title>
            <SheetPrimitive.Close
              aria-label={closeLabel}
              className="flex size-11 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            >
              <X className="size-5" aria-hidden />
            </SheetPrimitive.Close>
          </div>
          {children}
        </SheetPrimitive.Content>
      </SheetPrimitive.Portal>
    </SheetPrimitive.Root>
  );
}
