import * as React from "react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

const SIDEBAR_WIDTH_MOBILE = "16rem";

interface SidebarMobileSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "left" | "right";
  children: React.ReactNode;
}

export function SidebarMobileSheet({
  open,
  onOpenChange,
  side = "left",
  children,
}: SidebarMobileSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        data-sidebar="sidebar"
        data-mobile="true"
        className="border-sidebar-border bg-sidebar p-0 text-sidebar-foreground shadow-xl [&>button]:hidden"
        style={
          {
            "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
            width: "min(var(--sidebar-width), calc(100vw - 2rem))",
            maxWidth: "calc(100vw - 2rem)",
          } as React.CSSProperties
        }
        side={side}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Sidebar</SheetTitle>
          <SheetDescription>Navigation sidebar</SheetDescription>
        </SheetHeader>
        <div className="flex h-full w-full flex-col">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
