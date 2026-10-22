import { useWatch } from "react-hook-form";
import { NET_TERMS_DAYS, RECORDED_PAYMENT_VIAS, type RecordedPaymentVia } from "@scalius/shared/payment-terms";
import { Input } from "@/components/ui/input";
import { orderDetailLabel } from "@/i18n/order-detail";
import { orderPaymentDialogMessages } from "@/i18n/order-payment-dialogs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { formatNumber, useMessages } from "@/i18n";
import { orderFormMessages } from "@/i18n/order-form";
import { Field, FieldRow } from "~/components/ui/field";
import { useOrderForm } from "./OrderFormContext";

const TERMS_ID = "order-payment-terms";
const PAID_VIA_ID = "order-paid-via";
const PAID_REFERENCE_ID = "order-paid-reference";
/** The store's net days (Settings → Payments), sent as no days at all. */
const STORE_TERMS = "store";

/**
 * New orders only: how the buyer pays. Cash on delivery; an invoice paid
 * later (net terms): the order is placed unpaid, due in the chosen days, and
 * payments are recorded on the order as they arrive; or already paid (cash at
 * the counter, a transfer, a wallet): the order is placed paid, so its
 * downloads and gift cards go out at once.
 */
export function PaymentSection() {
  const { form } = useOrderForm();
  const t = useMessages(orderFormMessages);
  const pd = useMessages(orderPaymentDialogMessages);
  const [method, days, via, reference] = useWatch({ control: form.control, name: ["paymentMethod", "paymentTermsDays", "paidVia", "paidReference"] });
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
          onValueChange={(value) => form.setValue("paymentMethod", value as "cod" | "net_terms" | "paid", edit)}
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
          <label className="flex min-h-11 items-center gap-3 text-body">
            <RadioGroupItem value="paid" />
            {t("paymentPaid")}
          </label>
        </RadioGroup>
        {method === "paid" ? (
          <FieldRow>
            <Field id={PAID_VIA_ID} label={pd("netTerms.via")}>
              <SearchableSelect
                id={PAID_VIA_ID}
                triggerClassName="w-full"
                value={via ?? "cash"}
                onValueChange={(value) => form.setValue("paidVia", value as RecordedPaymentVia, edit)}
                options={RECORDED_PAYMENT_VIAS.map((each) => ({ value: each, label: orderDetailLabel(pd, "netTerms.via.", each) }))}
              />
            </Field>
            <Field id={PAID_REFERENCE_ID} label={pd("netTerms.reference")} optional>
              <Input
                id={PAID_REFERENCE_ID}
                value={reference ?? ""}
                maxLength={120}
                autoComplete="off"
                onChange={(event) => form.setValue("paidReference", event.target.value, edit)}
              />
            </Field>
          </FieldRow>
        ) : null}
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
