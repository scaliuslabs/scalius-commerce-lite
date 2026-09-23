import { Link } from "@tanstack/react-router";
import { ChevronRight, Gift, Package, Receipt, Truck } from "lucide-react";

import { DISCOUNT_TYPES, type DiscountType } from "./discount-form";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { useMessages } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";

const ICON: Record<DiscountType, typeof Package> = {
  products: Package,
  buy_get: Gift,
  order: Receipt,
  shipping: Truck,
};

/** "Create discount" → pick the type; code vs automatic is chosen in the editor. */
export function DiscountTypeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useMessages(discountsMessages);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("chooseType")}</DialogTitle>
        </DialogHeader>
        <ul className="divide-y rounded-md border">
          {DISCOUNT_TYPES.map((type) => {
            const Icon = ICON[type];
            return (
              <li key={type}>
                <Link
                  to="/admin/discounts/new"
                  search={{ type }}
                  className="flex min-h-14 items-start gap-3 px-4 py-3 text-body hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
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
