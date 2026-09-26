import { useWatch, type UseFormReturn } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { giftCardProductMessages } from "~/i18n/gift-card-product";
import { productMessages } from "~/i18n/products";
import type { ProductFulfilmentMode } from "./fulfilment-mode";
import { useProductKindRules } from "./product-kind-rules";
import type { ProductFormValues } from "./types";

const HELP = {
  physical: "fulfilmentPhysicalHelp",
  digital: "fulfilmentDigitalHelp",
  service: "fulfilmentServiceHelp",
  mixed: "fulfilmentMixedHelp",
} as const;

/**
 * Shopify's "Physical product" switch as a select (Wave A §8.1): what the
 * product is decides whether an order ships, is picked up, or needs no
 * delivery at all. With options, each variant can differ (a Fulfilment
 * column in the variant table). Digital files and licence keys are added in
 * the Digital delivery card. A kind that forces the fulfilment (a gift card
 * is always digital) shows it instead of the select.
 */
export function FulfilmentCard({ form, hasOptions }: {
  form: UseFormReturn<ProductFormValues>;
  /** The product has options, so "set per variant" makes sense. */
  hasOptions: boolean;
}) {
  const t = useMessages(productMessages);
  const g = useMessages(giftCardProductMessages);
  const { forcedFulfillmentKind } = useProductKindRules();
  const mode = useWatch({ control: form.control, name: "fulfillmentKind" }) ?? "physical";
  const single: ProductFulfilmentMode[] = ["physical", "digital", "service"];
  const choices: ProductFulfilmentMode[] = hasOptions || mode === "mixed" ? [...single, "mixed"] : single;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("fulfilment")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {forcedFulfillmentKind ? (
          <>
            <p className="text-body font-medium">{t(`fulfilmentMode.${forcedFulfillmentKind}`)}</p>
            <p className="text-body text-muted-foreground">{g("fulfilmentForced")}</p>
          </>
        ) : (
          <>
            <SearchableSelect
              id="product-fulfilment"
              ariaLabel={t("fulfilment")}
              value={mode}
              aria-describedby="product-fulfilment-help"
              onValueChange={(value) => {
                const next = choices.find((choice) => choice === value);
                if (next) form.setValue("fulfillmentKind", next, { shouldDirty: true });
              }}
              triggerClassName="w-full"
              options={choices.map((choice) => ({ value: choice, label: t(`fulfilmentMode.${choice}`) }))}
            />
            <p id="product-fulfilment-help" className="text-body text-muted-foreground">{t(HELP[mode])}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
