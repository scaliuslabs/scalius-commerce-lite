import { useWatch, type UseFormReturn } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import type { ProductFulfilmentMode } from "./fulfilment-mode";
import type { ProductFormValues } from "./types";

const HELP = {
  physical: "fulfilmentPhysicalHelp",
  service: "fulfilmentServiceHelp",
  mixed: "fulfilmentMixedHelp",
} as const;

/**
 * Shopify's "Physical product" switch as a select (Wave A §8.1): what the
 * product is decides whether an order ships, is picked up, or needs no
 * delivery at all. With options, each variant can differ (a Fulfilment
 * column in the variant table). Digital and gift cards come with Wave B.
 */
export function FulfilmentCard({ form, hasOptions }: {
  form: UseFormReturn<ProductFormValues>;
  /** The product has options, so "set per variant" makes sense. */
  hasOptions: boolean;
}) {
  const t = useMessages(productMessages);
  const mode = useWatch({ control: form.control, name: "fulfillmentKind" }) ?? "physical";
  const choices: ProductFulfilmentMode[] = hasOptions || mode === "mixed" ? ["physical", "service", "mixed"] : ["physical", "service"];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("fulfilment")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <NativeSelect
          id="product-fulfilment"
          aria-label={t("fulfilment")}
          value={mode}
          aria-describedby="product-fulfilment-help"
          onValueChange={(value) => {
            const next = choices.find((choice) => choice === value);
            if (next) form.setValue("fulfillmentKind", next, { shouldDirty: true });
          }}
        >
          {choices.map((choice) => (
            <option key={choice} value={choice}>{t(`fulfilmentMode.${choice}`)}</option>
          ))}
        </NativeSelect>
        <p id="product-fulfilment-help" className="text-body text-muted-foreground">{t(HELP[mode])}</p>
      </CardContent>
    </Card>
  );
}
