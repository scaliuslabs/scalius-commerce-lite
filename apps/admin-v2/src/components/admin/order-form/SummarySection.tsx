import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "~/components/ui/form";
import { Input } from "~/components/ui/input";
import { Button } from "~/components/ui/button";
import { Loader2, RotateCcw } from "lucide-react";
import { useOrderForm } from "./OrderFormContext";
import { useCurrency } from "~/hooks/use-currency";
import { useMessages } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";
import { resourceMessages } from "~/i18n/resource";

const discountGuidanceId = "manual-order-discount-guidance";
const discountErrorId = "manual-order-discount-error";

/** Payment card: delivery charge, discount and the order total (from the server quote when there is one). */
export function SummarySection() {
  const { form, refs, handleKeyDown, isEdit, usesQuote, localTotals, manualQuote } =
    useOrderForm();
  const { fmt } = useCurrency();
  const t = useMessages(orderFormMessages);
  const r = useMessages(resourceMessages);

  const quote = usesQuote && manualQuote.isCurrent ? manualQuote.data : null;
  const subtotal = quote?.subtotalAmount ?? localTotals.subtotal;
  const shipping = quote?.shippingAmount ?? localTotals.shipping;
  const discount = quote?.discountAmount ?? localTotals.discount;
  const discountLimit = usesQuote ? manualQuote.discountLimit : null;
  const discountNeedsCorrection = discountLimit?.exceeded === true;
  const total = discountNeedsCorrection ? null : quote?.totalAmount ?? localTotals.total;

  const removeDiscount = () => {
    form.setValue("discountAmount", null, { shouldDirty: true, shouldValidate: true });
    refs.discountAmountRef.current?.focus();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("payment")}</CardTitle>
        {isEdit ? null : <CardDescription>{t("codNote")}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="shippingCharge"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("deliveryCharge")}</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="decimal"
                    placeholder="0"
                    step="0.01"
                    {...field}
                    value={field.value === 0 ? "" : field.value ?? ""}
                    ref={(el) => {
                      field.ref(el);
                      refs.shippingChargeRef.current = el;
                    }}
                    onChange={(e) => field.onChange(e.target.value ? parseFloat(e.target.value) : 0)}
                    onKeyDown={(e) => handleKeyDown(e, refs.discountAmountRef)}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="discountAmount"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("discount")}</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="decimal"
                    placeholder="0"
                    step="0.01"
                    max={discountLimit?.maximumAmount}
                    aria-invalid={discountNeedsCorrection || undefined}
                    aria-describedby={discountNeedsCorrection
                      ? `${discountGuidanceId} ${discountErrorId}`
                      : discountGuidanceId}
                    aria-errormessage={discountNeedsCorrection ? discountErrorId : undefined}
                    {...field}
                    value={field.value ?? ""}
                    ref={(el) => {
                      field.ref(el);
                      refs.discountAmountRef.current = el;
                    }}
                    onChange={(e) => field.onChange(e.target.value ? parseFloat(e.target.value) : null)}
                    onKeyDown={(e) => handleKeyDown(e)}
                  />
                </FormControl>
                <FormDescription id={discountGuidanceId}>{t("discountHelp")}</FormDescription>
                {discountNeedsCorrection && discountLimit ? (
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p id={discountErrorId} className="text-body font-medium text-destructive" role="alert">
                      {t("discountTooHigh", { amount: fmt(discountLimit.maximumAmount) })}
                    </p>
                    <Button type="button" variant="outline" size="sm" onClick={removeDiscount}>
                      {t("removeDiscount")}
                    </Button>
                  </div>
                ) : null}
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {usesQuote && manualQuote.errorMessage ? (
          <div className="flex flex-wrap items-start justify-between gap-2" role="alert">
            <p className="text-body text-destructive">{manualQuote.errorMessage}</p>
            {manualQuote.canRetry ? (
              <Button type="button" variant="outline" size="sm" onClick={manualQuote.retry}>
                <RotateCcw className="h-4 w-4" />
                {r("retry")}
              </Button>
            ) : null}
          </div>
        ) : null}

        <dl className="space-y-2 border-t pt-4 text-body">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t("subtotal")}</dt>
            <dd>{fmt(subtotal)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t("deliveryCharge")}</dt>
            <dd>{fmt(shipping)}</dd>
          </div>
          {discount > 0 ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t("discount")}</dt>
              <dd>{fmt(-discount)}</dd>
            </div>
          ) : null}
          {quote && (quote.taxEnabled || quote.taxAmount > 0) ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">
                {quote.pricesIncludeTax ? t("taxIncluded", { label: quote.taxLabel }) : quote.taxLabel}
              </dt>
              <dd>{fmt(quote.taxAmount)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-4 border-t pt-2 font-semibold">
            <dt>{t("total")}</dt>
            <dd className={total == null ? "text-destructive" : undefined}>
              {total == null ? t("fixDiscount") : fmt(total)}
            </dd>
          </div>
        </dl>

        {usesQuote ? (
          // Always one line tall so the card does not jump while the total loads.
          <p className="flex min-h-5 items-start gap-2 text-body text-muted-foreground" aria-live="polite">
            {manualQuote.isLoading ? (
              <>
                <span className="flex h-5 items-center">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </span>
                {t("calculating")}
              </>
            ) : null}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
