import { memo } from "react";
import type { UseFormReturn } from "react-hook-form";
import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormControl, FormDescription, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { NativeSelect } from "@/components/ui/native-select";
import { Button } from "@/components/ui/button";
import { PRODUCT_CONDITION_VALUES, type ProductCondition } from "@scalius/shared/product-condition";
import { useMessages } from "~/i18n";
import { productMessages, type ProductMessageKey } from "~/i18n/products";
import type { ProductFormValues } from "./types";

const CONDITION_LABELS: Record<ProductCondition, ProductMessageKey> = {
  new: "conditionNew",
  refurbished: "conditionRefurbished",
  used: "conditionUsed",
};

interface StatusCardProps {
  form: UseFormReturn<ProductFormValues>;
  /** Saved products only. */
  storefrontUrl?: string;
}

export const StatusCard = memo(function StatusCard({ form, storefrontUrl }: StatusCardProps) {
  const t = useMessages(productMessages);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("status")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField
          control={form.control}
          name="isActive"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <NativeSelect
                  value={field.value ? "active" : "draft"}
                  onValueChange={(value) => field.onChange(value === "active")}
                  aria-label={t("status")}
                >
                  <option value="active">{t("statusActive")}</option>
                  <option value="draft">{t("statusDraft")}</option>
                </NativeSelect>
              </FormControl>
              <FormDescription>{t(field.value ? "statusActiveHelp" : "statusDraftHelp")}</FormDescription>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="freeDelivery"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between">
              <FormLabel>{t("freeDelivery")}</FormLabel>
              <FormControl>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="productCondition"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("condition")}</FormLabel>
              <FormControl>
                <NativeSelect value={field.value} onValueChange={field.onChange}>
                  {PRODUCT_CONDITION_VALUES.map((condition) => (
                    <option key={condition} value={condition}>
                      {t(CONDITION_LABELS[condition])}
                    </option>
                  ))}
                </NativeSelect>
              </FormControl>
            </FormItem>
          )}
        />

        {storefrontUrl ? (
          <Button variant="outline" asChild className="w-full">
            <a href={storefrontUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-2 h-4 w-4" />
              {t("viewOnStorefront")}
            </a>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
});
