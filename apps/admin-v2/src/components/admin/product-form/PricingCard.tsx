import { useEffect, useId, useState } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { NumberInput } from "@/components/ui/number-input";
import { MoneyInput } from "@/components/admin/shared/MoneyInput";
import { Label } from "@/components/ui/label";
import { CostInput, formatMargin } from "@/components/admin/inventory/cost-fields";
import { useCurrency } from "@/hooks/use-currency";
import { costMargin, costProblem } from "@/lib/api-query-options/inventory-costs";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { pairFromStored, storedFromPair, type PricePair } from "./compare-at";
import { useProductKindRules } from "./product-kind-rules";
import { useSkuCosts, type SkuCostStore } from "./sku-costs";
import type { ProductFormValues } from "./types";
import type { VariantPriceRange } from "./variants/option-matrix-editor-model";

/**
 * Shopify's pricing card. A product without options has a Price (what
 * customers pay) and an optional Compare-at price (what it cost before, shown
 * crossed out); the store keeps them as a base price and a discount
 * (`compare-at.ts`). With options each variant has its own price, so the card
 * shows their range instead of a price nobody pays; a discount saved on the
 * product itself still applies to variants without one, and stays editable.
 */
export function PricingCard({ form, variantPrices }: {
  form: UseFormReturn<ProductFormValues>;
  variantPrices: VariantPriceRange | null;
}) {
  const t = useMessages(productMessages);
  const { showDiscount, giftCard } = useProductKindRules();
  const { symbol, fmt, salePrice } = useCurrency();
  const costs = useSkuCosts();
  const [price, discountType, discountPercentage, discountAmount] = useWatch({
    control: form.control,
    name: ["price", "discountType", "discountPercentage", "discountAmount"],
  });
  const validPrice = Number.isFinite(price) ? price ?? 0 : 0;
  const sale = salePrice(validPrice, { discountType, discountPercentage, discountAmount });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("pricing")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {variantPrices ? (
          <>
            <div className="space-y-1">
              <p className="text-body font-medium">{t("priceLabel", { symbol })}</p>
              <p className="text-body tabular-nums">
                {variantPrices.min === variantPrices.max
                  ? fmt(variantPrices.min)
                  : `${fmt(variantPrices.min)}–${fmt(variantPrices.max)}`}
              </p>
              <p className="text-body text-muted-foreground">{t("variantPricesHint")}</p>
            </div>
            {showDiscount && sale !== null ? <ProductDiscountFields form={form} /> : null}
          </>
        ) : (
          // A gift card is worth its price: no compare-at price (the product kind rules).
          <PriceFields form={form} compareAtAllowed={showDiscount} />
        )}

        {/* One cost for a product without options; with options each variant has its own.
            A gift card is worth its price, so it has no cost per item. */}
        {costs && !variantPrices && !giftCard ? (
          <ProductCostFields costs={costs} customerPays={Number.isFinite(price) ? sale ?? price ?? null : null} />
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * Price and Compare-at price. The two numbers are held here while they are
 * typed (a half-typed compare-at price can't be stored yet) and written to the
 * product's base price and discount whenever they make sense together. A
 * compare-at price that can't be stored blocks the save with its reason.
 */
function PriceFields({ form, compareAtAllowed }: { form: UseFormReturn<ProductFormValues>; compareAtAllowed: boolean }) {
  const t = useMessages(productMessages);
  const { symbol, code, salePrice } = useCurrency();
  const decimalPlaces = getDecimalPlaces(code);
  const [price, discountType, discountPercentage, discountAmount] = useWatch({
    control: form.control,
    name: ["price", "discountType", "discountPercentage", "discountAmount"],
  });
  const saleOf = (base: number | null | undefined, type: typeof discountType, percentage: number | null | undefined, amount: number | null | undefined) =>
    Number.isFinite(base)
      ? salePrice(base ?? 0, { discountType: type, discountPercentage: percentage, discountAmount: amount })
      : null;
  const keyOf = (...parts: unknown[]) => parts.join("|");
  const storedKey = keyOf(price, discountType, discountPercentage, discountAmount);
  const [pair, setPair] = useState<PricePair>(() => pairFromStored(price ?? null, saleOf(price, discountType, discountPercentage, discountAmount)));
  const [syncedKey, setSyncedKey] = useState(storedKey);
  // Follow outside changes (discard, a reload after a conflict), not the ones made here.
  if (storedKey !== syncedKey) {
    setSyncedKey(storedKey);
    setPair(pairFromStored(price ?? null, saleOf(price, discountType, discountPercentage, discountAmount)));
  }

  // A compare-at price that is no longer on the page can't hold the save back.
  useEffect(() => {
    if (!compareAtAllowed) form.setValue("compareAtProblem", null);
    return () => form.setValue("compareAtProblem", null);
  }, [form, compareAtAllowed]);

  const change = (next: PricePair) => {
    setPair(next);
    const out = storedFromPair(next, decimalPlaces);
    const set = <K extends "price" | "discountType" | "discountPercentage" | "discountAmount">(name: K, value: ProductFormValues[K]) =>
      form.setValue(name, value, { shouldDirty: true, shouldValidate: Boolean(form.getFieldState(name).error) });
    set("price", out.price);
    // A product with no discount keeps its empty discount fields as saved.
    const touchesDiscount = out.discounted || saleOf(price, discountType, discountPercentage, discountAmount) !== null;
    if (touchesDiscount) {
      set("discountType", out.discounted ? "flat" : "percentage");
      set("discountPercentage", 0);
      set("discountAmount", out.discountAmount);
    }
    form.setValue("compareAtProblem", out.problem, { shouldValidate: Boolean(form.getFieldState("compareAtProblem").error) });
    setSyncedKey(touchesDiscount
      ? keyOf(out.price, out.discounted ? "flat" : "percentage", 0, out.discountAmount)
      : keyOf(out.price, discountType, discountPercentage, discountAmount));
  };

  return (
    <div className={cn("grid gap-4", compareAtAllowed && "sm:grid-cols-2")}>
      <FormField
        control={form.control}
        name="price"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("priceLabel", { symbol })}</FormLabel>
            <FormControl>
              <MoneyInput
                currencyCode={code}
                ref={field.ref}
                name={field.name}
                placeholder="0.00"
                value={pair.price}
                onValueChange={(next) => change({ ...pair, price: next })}
                onBlur={field.onBlur}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      {compareAtAllowed ? (
        <FormField
          control={form.control}
          name="compareAtProblem"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("compareAtLabel", { symbol })}</FormLabel>
              <FormControl>
                <MoneyInput
                  currencyCode={code}
                  ref={field.ref}
                  placeholder="0.00"
                  value={pair.compareAt}
                  onValueChange={(next) => change({ ...pair, compareAt: next })}
                  // Said as the merchant leaves the field, not while they type.
                  onBlur={() => {
                    field.onBlur();
                    void form.trigger("compareAtProblem");
                  }}
                />
              </FormControl>
              <FormMessage />
              <p className="text-body text-muted-foreground">{t("compareAtHelp")}</p>
            </FormItem>
          )}
        />
      ) : null}
    </div>
  );
}

/** A product with options that already carries a product-level discount: change or remove it here. */
function ProductDiscountFields({ form }: { form: UseFormReturn<ProductFormValues> }) {
  const t = useMessages(productMessages);
  const { symbol, code } = useCurrency();
  const discountType = useWatch({ control: form.control, name: "discountType" });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FormField
        control={form.control}
        name="discountType"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("discountType")}</FormLabel>
            <FormControl>
              <SearchableSelect
                value={field.value}
                onValueChange={(value) => {
                  field.onChange(value);
                  form.setValue(value === "flat" ? "discountPercentage" : "discountAmount", 0, {
                    shouldDirty: true,
                    shouldValidate: true,
                  });
                }}
                triggerClassName="w-full"
                triggerRef={field.ref}
                onBlur={field.onBlur}
                options={[{ value: "percentage", label: t("discountPercentage") }, { value: "flat", label: t("discountFixed") }]}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        key={discountType}
        control={form.control}
        name={discountType === "flat" ? "discountAmount" : "discountPercentage"}
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              {discountType === "flat" ? t("discountAmountLabel", { symbol }) : t("discountPercentLabel")}
            </FormLabel>
            <FormControl>
              {/* A flat discount is money (whole taka in BDT); a percentage is not. */}
              {discountType === "flat" ? (
                <MoneyInput
                  currencyCode={code}
                  ref={field.ref}
                  name={field.name}
                  placeholder="0"
                  value={field.value}
                  onValueChange={field.onChange}
                  onBlur={field.onBlur}
                />
              ) : (
                <NumberInput
                  ref={field.ref}
                  name={field.name}
                  placeholder="0"
                  value={field.value}
                  onValueChange={field.onChange}
                  onBlur={field.onBlur}
                />
              )}
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <p className="text-body text-muted-foreground sm:col-span-2">{t("variantDiscountHint")}</p>
    </div>
  );
}

/**
 * Shopify's cost row: cost per item, then the profit and margin of what the
 * customer pays (after the product discount). Costs keep paisa; customers
 * never see them.
 */
function ProductCostFields({ costs, customerPays }: { costs: SkuCostStore; customerPays: number | null }) {
  const t = useMessages(productMessages);
  const { symbol, code, fmt } = useCurrency();
  const id = useId();
  const cost = costs.costOf(costs.simpleKey);
  const problem = costProblem(cost);
  const result = costMargin(customerPays, cost, getDecimalPlaces(code));
  return (
    <div className="grid gap-4 border-t pt-4 sm:grid-cols-3">
      <div className="space-y-2">
        <Label htmlFor={id}>{t("costPerItem")}</Label>
        <CostInput
          id={id}
          symbol={symbol}
          value={cost}
          aria-invalid={problem ? true : undefined}
          aria-describedby={`${id}-help`}
          onValueChange={(next) => costs.setCosts([costs.simpleKey], next)}
        />
        <p id={`${id}-help`} className={cn("text-body", problem ? "text-destructive" : "text-muted-foreground")}>
          {problem ? t(problem === "costInvalid" ? "issueCostInvalid" : "issueCostTooLarge") : t("costHelp")}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-4 sm:col-span-2">
        <div className="space-y-2">
          <dt className="text-body font-medium">{t("profit")}</dt>
          <dd className={cn("flex h-11 items-center text-body tabular-nums sm:h-9", result && result.profit < 0 && "text-destructive")}>
            {result ? fmt(result.profit) : "—"}
          </dd>
        </div>
        <div className="space-y-2">
          <dt className="text-body font-medium">{t("margin")}</dt>
          <dd className={cn("flex h-11 items-center text-body tabular-nums sm:h-9", result?.margin != null && result.margin < 0 && "text-destructive")}>
            {formatMargin(result?.margin)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
