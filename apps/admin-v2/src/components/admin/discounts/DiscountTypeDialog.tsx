import { Link } from "@tanstack/react-router";
import { ChevronRight, Gift, ShoppingBag, Tag, Truck } from "lucide-react";
import { useRef } from "react";

import { DISCOUNT_TYPES, type DiscountType } from "./discount-form";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { useMessages } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";

const ICON: Record<DiscountType, typeof Tag> = {
  products: Tag,
  buy_get: Gift,
  order: ShoppingBag,
  shipping: Truck,
};

/** "Create discount" → pick the type; code vs automatic is chosen in the editor. */
export function DiscountTypeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useMessages(discountsMessages);
  const first = useRef<HTMLAnchorElement>(null);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onOpenAutoFocus={(event) => {
          // Start on the first type, not the Close button.
          event.preventDefault();
          first.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("chooseType")}</DialogTitle>
        </DialogHeader>
        <ul className="divide-y rounded-md border">
          {DISCOUNT_TYPES.map((type, index) => {
            const Icon = ICON[type];
            return (
              <li key={type}>
                <Link
                  ref={index === 0 ? first : undefined}
                  to="/admin/discounts/new"
                  search={{ type }}
                  className="flex min-h-14 items-start gap-3 px-4 py-3 text-body hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="flex h-lh shrink-0 items-center">
                    <Icon aria-hidden className="size-4 text-muted-foreground" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{t(`type_${type}`)}</span>
                    <span className="block text-muted-foreground">{t(`type_${type}_help`)}</span>
                  </span>
                  <span className="flex h-lh shrink-0 items-center">
                    <ChevronRight aria-hidden className="size-4 text-muted-foreground" />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
