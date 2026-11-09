import { useWatch, type UseFormReturn } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormField } from "@/components/ui/form";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { ShippingProfile } from "~/lib/api-query-options/shipping-profiles";
import { seededName } from "~/lib/seeded-names";
import { useMessages } from "~/i18n";
import { giftCardProductSummaryMessages as giftCardProductMessages } from "~/i18n/gift-card-product-summary";
import { productMessages } from "~/i18n/products";
import type { ProductFulfilmentMode } from "./fulfilment-mode";
import { useProductKindRules } from "./product-kind-rules";
import type { ProductFormValues } from "./types";
import { Field, ReadOnlyValue } from "~/components/ui/field";

const DEFAULT_PROFILE = "shp_default";

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
 * the table) and its shipping profile (Shopify's: which delivery prices it
 * pays; a free profile ships it free). A store with one profile shows none.
 * A gift card is always digital: the card says so instead of offering the
 * select.
 */
export function ShippingCard({ form, hasOptions, weightSlot, readOnly = false, profiles = [] }: {
  /** The store's shipping profiles (none or one: no choice to show). */
  profiles?: readonly ShippingProfile[];
  /** Viewers read the saved fulfilment and shipping profile as text. */
  readOnly?: boolean;
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
  const profileId = useWatch({ control: form.control, name: "shippingProfileId" }) ?? null;
  const profileLabel = (profile: ShippingProfile) => profile.isDefault
    ? t("shippingProfileDefault", { name: seededName(profile) })
    : profile.freeDelivery ? t("shippingProfileFree", { name: seededName(profile) }) : seededName(profile);
  const current = profiles.find((profile) => profile.id === (profileId ?? DEFAULT_PROFILE));
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
        ) : readOnly ? (
          <ReadOnlyValue label={t("fulfilment")} value={t(`fulfilmentMode.${mode}`)} help={t(HELP[mode])} />
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
        {ships && profiles.length > 1 ? (
          <div className="border-t pt-4">
            {readOnly ? (
              <ReadOnlyValue label={t("shippingProfile")} value={current ? profileLabel(current) : null} />
            ) : <FormField
              control={form.control}
              name="shippingProfileId"
              render={({ field }) => (
                <Field id="product-shipping-profile" label={t("shippingProfile")} help={t("shippingProfileHelp")}>
                  <SearchableSelect
                    value={field.value ?? DEFAULT_PROFILE}
                    onValueChange={(value) => field.onChange(value === DEFAULT_PROFILE ? null : value)}
                    triggerClassName="w-full"
                    options={profiles.map((profile) => ({ value: profile.id, label: profileLabel(profile) }))}
                  />
                </Field>
              )}
            />}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
