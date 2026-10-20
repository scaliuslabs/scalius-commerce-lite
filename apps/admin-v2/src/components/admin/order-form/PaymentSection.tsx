import { useWatch } from "react-hook-form";
import { NET_TERMS_DAYS } from "@scalius/shared/payment-terms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatNumber, useMessages } from "@/i18n";
import { orderFormMessages } from "@/i18n/order-form";
import { Field } from "~/components/ui/field";
import { useOrderForm } from "./OrderFormContext";

const TERMS_ID = "order-payment-terms";
/** The store's net days (Settings → Payments), sent as no days at all. */
const STORE_TERMS = "store";

/**
 * New orders only: how the buyer pays. Cash on delivery, or an invoice paid
 * later (net terms): the order is placed unpaid, due in the chosen days, and
 * payments are recorded on the order as they arrive.
 */
export function PaymentSection() {
  const { form } = useOrderForm();
  const t = useMessages(orderFormMessages);
  const [method, days] = useWatch({ control: form.control, name: ["paymentMethod", "paymentTermsDays"] });
  const edit = { shouldDirty: true, shouldValidate: form.formState.isSubmitted };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("paymentTitle")}</CardTitle>
        <CardDescription>{t("paymentHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <RadioGroup
          value={method ?? "cod"}
          onValueChange={(value) => form.setValue("paymentMethod", value as "cod" | "net_terms", edit)}
          aria-label={t("paymentTitle")}
        >
          <label className="flex min-h-11 items-center gap-3 text-body">
            <RadioGroupItem value="cod" />
            {t("paymentCod")}
          </label>
          <label className="flex min-h-11 items-center gap-3 text-body">
            <RadioGroupItem value="net_terms" />
            {t("paymentInvoice")}
          </label>
        </RadioGroup>
        {method === "net_terms" ? (
          <Field id={TERMS_ID} label={t("paymentTerms")} help={t("paymentTermsHelp")}>
            <SearchableSelect
              id={TERMS_ID}
              triggerClassName="w-full"
              value={days ? String(days) : STORE_TERMS}
              onValueChange={(value) => form.setValue("paymentTermsDays", value === STORE_TERMS ? null : Number(value), edit)}
              options={[
                { value: STORE_TERMS, label: t("paymentTermsStore") },
                ...NET_TERMS_DAYS.map((each) => ({ value: String(each), label: t("paymentTermsDays", { days: formatNumber(each) }) })),
              ]}
            />
          </Field>
        ) : null}
      </CardContent>
    </Card>
  );
}
