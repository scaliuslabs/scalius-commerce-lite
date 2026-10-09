import { useWatch, type UseFormReturn } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormField } from "@/components/ui/form";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Checkbox } from "@/components/ui/checkbox";
import { useMessages } from "~/i18n";
import { giftCardProductMessages } from "~/i18n/gift-card-product";
import { productMessages } from "~/i18n/products";
import type { ProductFulfilmentMode } from "./fulfilment-mode";
import { useProductKindRules } from "./product-kind-rules";
import type { ProductFormValues } from "./types";
import { Field, ChoiceField } from "~/components/ui/field";

const HELP = {
  physical: "fulfilmentPhysicalHelp",
  digital: "fulfilmentDigitalHelp",
  service: "fulfilmentServiceHelp",
  mixed: "fulfilmentMixedHelp",
} as const;

/**
 * Shopify's Shipping card: whether the product is physical (Shopify's
 * "Physical product" switch, here a select because Scalius also sells
 * downloads and services, or each variant its own), then what only a parcel
 * needs: its weight (a product without options; variants carry their own in
 * the table) and free delivery. A gift card is always digital: the card says
 * so instead of offering the select.
 */
export function ShippingCard({ form, hasOptions, weightSlot }: {
  form: UseFormReturn<ProductFormValues>;
  /** The product has options, so "set per variant" makes sense. */
  hasOptions: boolean;
  /** Where the variant editor draws a product's weight (see editor-slots.ts). */
  weightSlot?: (element: HTMLDivElement | null) => void;
}) {
  const t = useMessages(productMessages);
  const g = useMessages(giftCardProductMessages);
  const { forcedFulfillmentKind, showShipping } = useProductKindRules();
  const mode = useWatch({ control: form.control, name: "fulfillmentKind" }) ?? "physical";
  const single: ProductFulfilmentMode[] = ["physical", "digital", "service"];
  const choices: ProductFulfilmentMode[] = hasOptions || mode === "mixed" ? [...single, "mixed"] : single;
  const ships = showShipping && (mode === "physical" || mode === "mixed");
  return (
    <Card id="product-shipping" className="scroll-mt-4">
      <CardHeader>
        <CardTitle>{t("shipping")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {forcedFulfillmentKind ? (
          <div className="space-y-1">
            <p className="text-body font-medium">{t(`fulfilmentMode.${forcedFulfillmentKind}`)}</p>
            <p className="text-body text-muted-foreground">{g("fulfilmentForced")}</p>
          </div>
        ) : (
          <Field id="product-fulfilment" help={t(HELP[mode])}>
            <SearchableSelect
              ariaLabel={t("fulfilment")}
              value={mode}
              onValueChange={(value) => {
                const next = choices.find((choice) => choice === value);
                if (next) form.setValue("fulfillmentKind", next, { shouldDirty: true });
              }}
              triggerClassName="w-full"
              options={choices.map((choice) => ({ value: choice, label: t(`fulfilmentMode.${choice}`) }))}
            />
          </Field>
        )}
        <div ref={weightSlot} className="empty:hidden" />
        {ships ? (
          <div className="border-t pt-4">
            <FormField
              control={form.control}
              name="freeDelivery"
              render={({ field }) => (
                <ChoiceField
                  id="product-free-delivery"
                  label={t("freeDelivery")}
                  control={<Checkbox id="product-free-delivery" checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />}
                />
              )}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
