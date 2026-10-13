import { useState } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { Switch } from "@/components/ui/switch";
import { useMessages } from "~/i18n";
import { giftCardProductMessages } from "~/i18n/gift-card-product";
import { productMessages } from "~/i18n/products";
import { CollapsibleCard } from "./CollapsibleCard";
import type { ProductFormValues } from "./types";
import { ChoiceField, ReadOnlyValue } from "~/components/ui/field";

const RULES = [
  "productRuleDenominations",
  "productRuleDelivery",
  "productRuleNoTracking",
  "productRuleNoGiftCardTender",
] as const;

/**
 * Shopify's "This product is a gift card" (Wave B §4.2, §9.1). A gift card's
 * variants are denominations, delivered as a code by email or SMS: the API
 * forces every SKU digital and untracked and refuses discounts
 * (`products/gift-card-rules.ts`), so switching it on also sets the product's
 * fulfilment to digital and clears the product discount, which the API would
 * otherwise reject.
 */
export function GiftCardProductCard({ form, readOnly }: {
  form: UseFormReturn<ProductFormValues>;
  /** Unset while the product is being added. */
  productId: string | undefined;
  readOnly: boolean;
}) {
  const t = useMessages(giftCardProductMessages);
  const p = useMessages(productMessages);
  const draftGiftCard = useWatch({ control: form.control, name: "isGiftCard" }) ?? false;
  const isGiftCard = readOnly ? form.formState.defaultValues?.isGiftCard === true : draftGiftCard;
  // Say what else changed only right after this switch changed it.
  const [switchedOn, setSwitchedOn] = useState(false);

  const change = (next: boolean) => {
    if (readOnly) return;
    form.setValue("isGiftCard", next, { shouldDirty: true });
    setSwitchedOn(false);
    if (!next) return;
    const values = form.getValues();
    let adjusted = false;
    if (values.fulfillmentKind !== "digital") {
      form.setValue("fulfillmentKind", "digital", { shouldDirty: true });
      adjusted = true;
    }
    if ((values.discountPercentage ?? 0) > 0 || (values.discountAmount ?? 0) > 0) {
      form.setValue("discountPercentage", 0, { shouldDirty: true });
      form.setValue("discountAmount", 0, { shouldDirty: true });
      adjusted = true;
    }
    setSwitchedOn(adjusted);
  };

  return (
    // Closed unless the product is a gift card: the switch stays one click away.
    <CollapsibleCard
      id="product-gift-card"
      title={p("giftCardProduct")}
      defaultOpen={isGiftCard}
      summary={<p className="text-body text-muted-foreground">{t(isGiftCard ? "productSummaryOn" : "productSummaryOff")}</p>}
    >
        {readOnly ? <ReadOnlyValue label={t("productSwitch")} value={t(isGiftCard ? "productSummaryOn" : "productSummaryOff")} /> : <ChoiceField
          id="product-gift-card"
          controlAt="end"
          label={t("productSwitch")}
          help={t("productSwitchHelp")}
          control={(
            <Switch
              id="product-gift-card"
              checked={isGiftCard}
              aria-describedby="product-gift-card-help"
              onCheckedChange={change}
            />
          )}
        />}
        {isGiftCard ? (
          <div className="space-y-2 border-t pt-3">
            <ul className="list-disc space-y-1 ps-5 text-body text-muted-foreground">
              {RULES.map((rule) => <li key={rule}>{t(rule)}</li>)}
            </ul>
            {!readOnly && switchedOn ? <p role="status" className="text-body">{t("productSwitchedOn")}</p> : null}
          </div>
        ) : null}
    </CollapsibleCard>
  );
}
