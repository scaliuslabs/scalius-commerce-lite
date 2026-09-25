import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";

import { overlayClassName } from "./dialog";

interface SidebarMobileSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The drawer's accessible name, e.g. "Main navigation". */
  label: string;
  children: React.ReactNode;
}

/**
 * The phone navigation drawer: the same near-black panel as on a desktop,
 * sliding in from the left over a dimmed page. Escape, the overlay and the
 * panel's own close button dismiss it, and focus goes back to whatever
 * opened it (the top bar's Menu button has no Dialog.Trigger to return to).
 */
export function SidebarMobileSheet({ open, onOpenChange, label, children }: SidebarMobileSheetProps) {
  const opener = React.useRef<HTMLElement | null>(null);
  return (
    <SheetPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <SheetPrimitive.Portal>
        <SheetPrimitive.Overlay className={overlayClassName} />
        <SheetPrimitive.Content
          data-nav=""
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            if (!opener.current?.isConnected) return;
            event.preventDefault();
            opener.current.focus();
          }}
          className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[calc(100vw-3rem)] flex-col bg-sidebar text-sidebar-foreground shadow-modal focus:outline-none data-[state=closed]:pointer-events-none data-[state=closed]:invisible motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:slide-in-from-left motion-safe:data-[state=open]:duration-200"
        >
          <SheetPrimitive.Title className="sr-only">{label}</SheetPrimitive.Title>
          {children}
        </SheetPrimitive.Content>
      </SheetPrimitive.Portal>
    </SheetPrimitive.Root>
  );
}
