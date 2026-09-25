import { useState } from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useMessages } from "~/i18n";
import { giftCardProductMessages } from "~/i18n/gift-card-product";
import { productMessages } from "~/i18n/products";
import type { ProductFormValues } from "./types";

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
  const isGiftCard = useWatch({ control: form.control, name: "isGiftCard" }) ?? false;
  // Say what else changed only right after this switch changed it.
  const [switchedOn, setSwitchedOn] = useState(false);

  const change = (next: boolean) => {
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
    <Card>
      <CardHeader>
        <CardTitle>{p("giftCardProduct")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="product-gift-card">{t("productSwitch")}</Label>
            <p id="product-gift-card-help" className="text-body text-muted-foreground">{t("productSwitchHelp")}</p>
          </div>
          <span className="flex h-lh items-center">
            <Switch
              id="product-gift-card"
              checked={isGiftCard}
              disabled={readOnly}
              aria-describedby="product-gift-card-help"
              onCheckedChange={change}
            />
          </span>
        </div>
        {isGiftCard ? (
          <div className="space-y-2 border-t pt-3">
            <ul className="list-disc space-y-1 pl-5 text-body text-muted-foreground">
              {RULES.map((rule) => <li key={rule}>{t(rule)}</li>)}
            </ul>
            {switchedOn ? <p role="status" className="text-body">{t("productSwitchedOn")}</p> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
