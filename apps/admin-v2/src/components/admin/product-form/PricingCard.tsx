import { useEffect, useState } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormField } from "@/components/ui/form";
import { CostInput, MoneyInput } from "@/components/admin/shared/MoneyInput";
import { formatMargin } from "@/components/admin/inventory/cost-fields";
import { useCurrency } from "@/hooks/use-currency";
import { costMargin, costProblem } from "@/lib/api-query-options/inventory-costs";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { pairFromStored, storedFromPair, type PricePair } from "./compare-at";
import { useProductKindRules } from "./product-kind-rules";
import { useSkuCosts, type SkuCostStore } from "./sku-costs";
import type { ProductFormValues } from "./types";
import type { VariantPriceRange } from "./variants/option-matrix-editor-model";
import { Field, FieldRow, ReadOnlyValue } from "~/components/ui/field";


/**
 * Shopify's pricing card. A product without options has a Price (what
 * customers pay) and an optional Compare-at price (what it cost before, shown
 * crossed out); the store keeps them as a base price and a discount
 * (`compare-at.ts`). With options each variant has its own price and
 * compare-at price, so the card shows the range customers pay; the product
 * itself keeps no discount.
 */
export function PricingCard({ form, variantPrices, readOnly = false }: {
  form: UseFormReturn<ProductFormValues>;
  variantPrices: VariantPriceRange | null;
  /** Viewers read the saved prices as text; nothing that writes the form is mounted. */
  readOnly?: boolean;
}) {
  const t = useMessages(productMessages);
  const { showDiscount, giftCard } = useProductKindRules();
  const { fmt, salePrice } = useCurrency();
  const costs = useSkuCosts();
  const [price, discountType, discountPercentage, discountAmount] = useWatch({
    control: form.control,
    name: ["price", "discountType", "discountPercentage", "discountAmount"],
  });
  const validPrice = Number.isFinite(price) ? price ?? 0 : 0;
  const sale = salePrice(validPrice, { discountType, discountPercentage, discountAmount });
  const storedPrice = Number.isFinite(price) ? price ?? null : null;
  const pair = pairFromStored(storedPrice, storedPrice === null ? null : sale);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("pricing")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {variantPrices ? (
          <ReadOnlyValue
            numeric
            label={t("priceLabel")}
            help={readOnly ? undefined : t("variantPricesHint")}
            value={variantPrices.min === variantPrices.max
              ? fmt(variantPrices.min)
              : `${fmt(variantPrices.min)}–${fmt(variantPrices.max)}`}
          />
        ) : readOnly ? (
          <FieldRow>
            <ReadOnlyValue numeric label={t("priceLabel")} value={pair.price === null ? null : fmt(pair.price)} />
            {showDiscount ? <ReadOnlyValue numeric label={t("compareAtLabel")} value={pair.compareAt === null ? null : fmt(pair.compareAt)} /> : null}
          </FieldRow>
        ) : (
          // A gift card is worth its price: no compare-at price (the product kind rules).
          <PriceFields form={form} compareAtAllowed={showDiscount} />
        )}

        {/* One cost for a product without options; with options each variant has its own.
            A gift card is worth its price, so it has no cost per item. */}
        {costs && !variantPrices && !giftCard ? (
          <ProductCostFields costs={costs} readOnly={readOnly} customerPays={Number.isFinite(price) ? sale ?? price ?? null : null} />
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
  const { code, salePrice } = useCurrency();
  const decimalPlaces = getDecimalPlaces(code);
  const [price, discountType, discountPercentage, discountAmount] = useWatch({
    control: form.control,
    name: ["price", "discountType", "discountPercentage", "discountAmount"],
  });
  const saleOf = (base: number | null | undefined, type: typeof discountType | undefined, percentage: number | null | undefined, amount: number | null | undefined) =>
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
    const baseline = form.formState.defaultValues;
    const baseOut = storedFromPair(pairFromStored(baseline?.price ?? null,
      saleOf(baseline?.price, baseline?.discountType, baseline?.discountPercentage, baseline?.discountAmount)), decimalPlaces);
    // Returning to the saved pair also restores its percentage/flat representation.
    const restored = baseline?.discountType !== undefined && !out.problem
      && out.price === baseOut.price && out.discounted === baseOut.discounted && out.discountAmount === baseOut.discountAmount;
    const nextType = restored ? baseline.discountType : out.discounted ? "flat" : "percentage";
    const nextPercentage = restored ? baseline.discountPercentage : 0;
    const nextAmount = restored ? baseline.discountAmount : out.discountAmount;
    const options = (name: "price" | "discountType" | "discountPercentage" | "discountAmount") =>
      ({ shouldDirty: true, shouldValidate: Boolean(form.getFieldState(name).error) });
    form.setValue("price", out.price, options("price"));
    // A product with no discount keeps its empty discount fields as saved.
    const touchesDiscount = restored || out.discounted || saleOf(price, discountType, discountPercentage, discountAmount) !== null;
    if (touchesDiscount) {
      form.setValue("discountType", nextType, options("discountType"));
      form.setValue("discountPercentage", nextPercentage, options("discountPercentage"));
      form.setValue("discountAmount", nextAmount, options("discountAmount"));
    }
    form.setValue("compareAtProblem", out.problem, { shouldValidate: Boolean(form.getFieldState("compareAtProblem").error) });
    setSyncedKey(touchesDiscount
      ? keyOf(out.price, nextType, nextPercentage, nextAmount)
      : keyOf(out.price, discountType, discountPercentage, discountAmount));
  };

  return (
    <FieldRow>
      <FormField
        control={form.control}
        name="price"
        render={({ field, fieldState }) => (
          <Field label={t("priceLabel")} error={fieldState.error?.message}>
            <MoneyInput
              currencyCode={code}
              ref={field.ref}
              name={field.name}
              placeholder="0.00"
              value={pair.price}
              onValueChange={(next) => change({ ...pair, price: next })}
              onBlur={field.onBlur}
            />
          </Field>
        )}
      />
      {compareAtAllowed ? (
        <FormField
          control={form.control}
          name="compareAtProblem"
          render={({ field, fieldState }) => (
            <Field label={t("compareAtLabel")} help={t("compareAtHelp")} error={fieldState.error?.message}>
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
            </Field>
          )}
        />
      ) : null}
    </FieldRow>
  );
}

/**
 * Shopify's cost row: cost per item, then the profit and margin of what the
 * customer pays (after the product discount). Costs keep paisa; customers
 * never see them.
 */
function ProductCostFields({ costs, customerPays, readOnly }: { costs: SkuCostStore; customerPays: number | null; readOnly: boolean }) {
  const t = useMessages(productMessages);
  const { code, fmt } = useCurrency();
  const cost = costs.costOf(costs.simpleKey, readOnly);
  const problem = costProblem(cost);
  const result = costMargin(customerPays, cost, getDecimalPlaces(code));
  const negative = (value: number | null | undefined, text: string) =>
    value != null && value < 0 ? <span className="text-destructive">{text}</span> : text;
  // The same two columns as Price and Compare-at price above (S5).
  return (
    <div className="border-t pt-4">
      <FieldRow>
        {readOnly ? (
          <ReadOnlyValue numeric label={t("costPerItem")} help={t("costHelp")} value={cost === null ? null : fmt(cost)} />
        ) : (
          <Field
            label={t("costPerItem")}
            help={t("costHelp")}
            error={problem ? t(problem === "costInvalid" ? "issueCostInvalid" : "issueCostTooLarge") : undefined}
          >
            <CostInput value={cost} onValueChange={(next) => costs.setCosts([costs.simpleKey], next)} />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-4">
          <ReadOnlyValue besideControls numeric label={t("profit")} value={result ? negative(result.profit, fmt(result.profit)) : null} />
          <ReadOnlyValue besideControls numeric label={t("margin")} value={result?.margin != null ? negative(result.margin, formatMargin(result.margin)) : null} />
        </div>
      </FieldRow>
    </div>
  );
}
