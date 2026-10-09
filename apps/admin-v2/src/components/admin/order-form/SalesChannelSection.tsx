import { useEffect, useRef } from "react";
import { useWatch } from "react-hook-form";
import { ORDER_CHANNEL_SOURCE_MAX_LENGTH } from "@scalius/shared/order-channel";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormField } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useMessages } from "@/i18n";
import { orderFormMessages } from "@/i18n/order-form";
import { orderChannelSourceLabel, orderMessages } from "@/i18n/orders";
import { useOrderForm } from "./OrderFormContext";
import { ORDER_SOURCE_CHOICES, type OrderSourceChoice } from "./types";
import { Field } from "~/components/ui/field";

const SOURCE_CHOICE_ID = "order-source";

/**
 * New orders only: where a staff-created order came in (Facebook, Instagram,
 * WhatsApp, a call, a walk-in, or the merchant's own words). Optional; the
 * order's channel is always Dashboard.
 */
export function SalesChannelSection() {
  const { form } = useOrderForm();
  const t = useMessages(orderFormMessages);
  const o = useMessages(orderMessages);
  const choice = useWatch({ control: form.control, name: "sourceChoice" });
  const edit = { shouldDirty: true, shouldValidate: form.formState.isSubmitted };
  // Picking "Other" moves straight to its name field once it shows. The
  // closing list hands focus back to its trigger on a timer; go after it.
  const focusName = useRef(false);
  useEffect(() => {
    if (choice !== "other" || !focusName.current) return;
    focusName.current = false;
    const timer = setTimeout(() => form.setFocus("sourceName"), 0);
    return () => clearTimeout(timer);
  }, [choice, form]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("salesChannel")}</CardTitle>
        <CardDescription>{t("salesChannelHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={SOURCE_CHOICE_ID}>{t("source")}</Label>
          <SearchableSelect
            id={SOURCE_CHOICE_ID}
            triggerClassName="w-full"
            clearable
            placeholder={t("sourceNone")}
            value={choice ?? ""}
            onValueChange={(value) => {
              focusName.current = value === "other";
              form.setValue("sourceChoice", (value || null) as OrderSourceChoice | null, edit);
              // The typed name belongs to "Other" only.
              if (value !== "other") form.setValue("sourceName", "", edit);
            }}
            options={ORDER_SOURCE_CHOICES.map((source) => ({
              value: source,
              label: source === "other" ? t("sourceOther") : orderChannelSourceLabel(o, source),
            }))}
          />
        </div>
        {choice === "other" ? (
          <FormField
            control={form.control}
            name="sourceName"
            render={({ field, fieldState }) => (
              <Field label={t("sourceName")} error={fieldState.error?.message}>
                <Input
                  {...field}
                  value={field.value ?? ""}
                  maxLength={ORDER_CHANNEL_SOURCE_MAX_LENGTH}
                  placeholder={t("sourceNamePlaceholder")}
                  autoComplete="off"
                />
              </Field>
            )}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
