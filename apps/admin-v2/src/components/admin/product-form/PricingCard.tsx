import { useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import type { ProductFormValues } from "./types";
import { useCurrency } from "@/hooks/use-currency";
import { cn } from "@scalius/shared/utils";

interface PricingCardProps {
  form: UseFormReturn<ProductFormValues>;
}

function formatMoney(symbol: string, value: number): string {
  return `${symbol}${new Intl.NumberFormat("en-BD", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0)}`;
}

// Not memoized: the compact summary follows the current price and discount.
export function PricingCard({ form }: PricingCardProps) {
  const { symbol } = useCurrency();
  const [showDiscount, setShowDiscount] = useState(false);
  const price = Number(form.watch("price") ?? 0);
  const discountType = form.watch("discountType");
  const discountPercentage = Number(form.watch("discountPercentage") ?? 0);
  const discountAmount = Number(form.watch("discountAmount") ?? 0);
  const discountErrors = form.formState.errors.discountType ||
    form.formState.errors.discountPercentage ||
    form.formState.errors.discountAmount;

  const discountOpen = showDiscount || Boolean(discountErrors);
  const rawDiscount = discountType === "flat"
    ? discountAmount
    : price * (discountPercentage / 100);
  const appliedDiscount = Math.min(Math.max(rawDiscount, 0), Math.max(price, 0));
  const effectivePrice = Math.max(price - appliedDiscount, 0);
  const hasDiscount = appliedDiscount > 0;
  const discountSummary = {
    effectivePrice,
    hasDiscount,
    label: !hasDiscount
      ? "No discount"
      : discountType === "flat"
        ? `${formatMoney(symbol, discountAmount)} off`
        : `${discountPercentage}% off`,
  };

  return (
    <Card>
      <CardHeader className="px-4 py-3">
        <CardTitle className="text-sm">Pricing</CardTitle>
      </CardHeader>

      <CardContent className="px-4 pb-3 pt-0">
        <div className="grid items-end gap-3 sm:grid-cols-[220px_1fr]">
          <FormField
            control={form.control}
            name="price"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">
                  Price <span className="text-destructive">*</span>
                </FormLabel>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    {symbol}
                  </span>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      placeholder="0.00"
                      className="pl-8"
                      {...field}
                      value={field.value || ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        field.onChange(value === "" ? 0 : Number(value));
                      }}
                    />
                  </FormControl>
                </div>
                <FormMessage />
              </FormItem>
            )}
          />

          <div className="pb-0.5 text-xs text-muted-foreground">
            {discountSummary.hasDiscount ? (
              <>
                Customer price
                <span className="ml-2 font-medium text-foreground">
                  {formatMoney(symbol, discountSummary.effectivePrice)}
                </span>
              </>
            ) : (
              "Set the regular selling price."
            )}
          </div>
        </div>
      </CardContent>

      <button
        type="button"
        className="flex min-h-10 w-full items-center justify-between gap-3 border-t px-4 py-2 text-left text-xs hover:bg-muted/35"
        onClick={() => setShowDiscount((open) => !open)}
        aria-expanded={discountOpen}
        aria-controls="product-discount-fields"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-medium">Discount</span>
          <Badge variant="secondary" className="h-5 max-w-[220px] truncate px-2 text-[10px] font-normal">
            {discountSummary.label}
          </Badge>
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            discountOpen && "rotate-180",
          )}
        />
      </button>

      {discountOpen ? (
        <CardContent
          id="product-discount-fields"
          className="grid gap-3 border-t bg-muted/15 px-4 py-3 sm:grid-cols-2"
        >
          <FormField
            control={form.control}
            name="discountType"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs">Discount type</FormLabel>
                <Select
                  onValueChange={(value) => {
                    field.onChange(value);
                    if (value === "flat") {
                      form.setValue("discountPercentage", 0, {
                        shouldDirty: true,
                        shouldValidate: true,
                      });
                    } else {
                      form.setValue("discountAmount", 0, {
                        shouldDirty: true,
                        shouldValidate: true,
                      });
                    }
                  }}
                  value={field.value}
                >
                  <FormControl>
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="percentage">Percentage</SelectItem>
                    <SelectItem value="flat">Fixed amount</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {discountType === "percentage" ? (
            <FormField
              control={form.control}
              name="discountPercentage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Percentage</FormLabel>
                  <div className="relative">
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="decimal"
                        placeholder="0"
                        min="0"
                        max="100"
                        step="0.01"
                        className="pr-8"
                        {...field}
                        value={field.value || ""}
                        onChange={(event) => {
                          const value = event.target.value;
                          field.onChange(value === "" ? 0 : Number(value));
                        }}
                      />
                    </FormControl>
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : (
            <FormField
              control={form.control}
              name="discountAmount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Amount</FormLabel>
                  <div className="relative">
                    <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{symbol}</span>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="decimal"
                        placeholder="0.00"
                        min="0"
                        step="0.01"
                        className="pl-8"
                        {...field}
                        value={field.value || ""}
                        onChange={(event) => {
                          const value = event.target.value;
                          field.onChange(value === "" ? 0 : Number(value));
                        }}
                      />
                    </FormControl>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </CardContent>
      ) : null}
    </Card>
  );
}
