import { Package, ReceiptText, Truck } from "lucide-react";

import type {
  PromotionEditorEffect,
  PromotionTarget,
} from "./promotion-editor-model";
import { PROMOTION_TARGETS } from "./promotion-editor-model";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

const TARGET_META = {
  line: {
    label: "Items",
    caption: "All merchandise lines",
    icon: Package,
  },
  order: {
    label: "Order",
    caption: "Subtotal after item savings",
    icon: ReceiptText,
  },
  shipping: {
    label: "Delivery",
    caption: "Authoritative delivery charge",
    icon: Truck,
  },
} as const;

export function PromotionEffectRail({
  effects,
  currencySymbol,
  onChange,
}: {
  effects: Record<PromotionTarget, PromotionEditorEffect>;
  currencySymbol: string;
  onChange: (target: PromotionTarget, effect: PromotionEditorEffect) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border">
      {PROMOTION_TARGETS.map((target, index) => {
        const meta = TARGET_META[target];
        const Icon = meta.icon;
        const effect = effects[target];
        return (
          <div
            key={target}
            className={`grid gap-3 p-3 sm:grid-cols-[minmax(11rem,1fr)_minmax(9rem,0.8fr)_minmax(8rem,0.8fr)] sm:items-center ${index > 0 ? "border-t" : ""} ${effect.enabled ? "bg-card" : "bg-muted/25"}`}
          >
            <label className="flex cursor-pointer items-center gap-3">
              <Checkbox
                checked={effect.enabled}
                onCheckedChange={(checked) => onChange(target, {
                  ...effect,
                  enabled: checked === true,
                })}
                aria-label={`Discount ${meta.label.toLowerCase()}`}
              />
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">
                <Icon className="size-4 text-muted-foreground" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{meta.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{meta.caption}</span>
              </span>
            </label>

            <Select
              disabled={!effect.enabled}
              value={effect.kind}
              onValueChange={(value) => onChange(target, {
                ...effect,
                kind: value as PromotionEditorEffect["kind"],
                value: value === "free" ? "" : effect.value || "10",
              })}
            >
              <SelectTrigger className="h-9" aria-label={`${meta.label} discount type`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="percentage_off">Percentage off</SelectItem>
                <SelectItem value="fixed_amount_off">Fixed amount off</SelectItem>
                {target === "shipping" ? <SelectItem value="free">Free delivery</SelectItem> : null}
              </SelectContent>
            </Select>

            {effect.kind === "free" ? (
              <div className="flex h-9 items-center rounded-md border border-dashed px-3 text-sm text-muted-foreground">
                Entire delivery charge
              </div>
            ) : (
              <label className="relative">
                <span className="sr-only">{meta.label} discount value</span>
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  {effect.kind === "percentage_off" ? "%" : currencySymbol}
                </span>
                <Input
                  disabled={!effect.enabled}
                  type="text"
                  inputMode="decimal"
                  value={effect.value}
                  onChange={(event) => onChange(target, { ...effect, value: event.target.value })}
                  className="h-9 pl-8"
                  placeholder={effect.kind === "percentage_off" ? "10" : "100"}
                />
              </label>
            )}
          </div>
        );
      })}
    </div>
  );
}
