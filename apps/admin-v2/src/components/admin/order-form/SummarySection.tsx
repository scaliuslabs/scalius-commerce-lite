import React from "react";
import { useQuery } from "@tanstack/react-query";
import { useWatch } from "react-hook-form";
import { getApiV1AdminSettingsShippingMethods } from "@scalius/api-client/sdk";
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
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Button } from "~/components/ui/button";
import { Loader2, RotateCcw } from "lucide-react";
import { useOrderForm } from "./OrderFormContext";
import { useCurrency } from "~/hooks/use-currency";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";
import { resourceMessages } from "~/i18n/resource";

const discountGuidanceId = "manual-order-discount-guidance";
const discountErrorId = "manual-order-discount-error";
const CUSTOM_CHARGE = "custom";
/**
 * The store's active delivery charges (every zone, then everywhere else) to
 * suggest a delivery charge; hidden without access. Same key as Settings →
 * Shipping, so both share one cache entry.
 */
function useShippingRates() {
  const { hasPermission } = usePermissions();
  const query = useQuery({
    queryKey: queryKeys.settings.shippingMethods(),
    queryFn: () => apiData(getApiV1AdminSettingsShippingMethods()),
    enabled: hasPermission(ADMIN_PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  const data = query.data;
  if (!data) return [];
  return [
    ...data.zones.flatMap((zone) => zone.rates.map((rate) => ({ ...rate, name: `${zone.name} · ${rate.name}` }))),
    ...data.everywhereElse.rates,
  ].filter((rate) => rate.isActive);
}

/** Payment card: delivery charge, discount and the order total from the server quote. */
export function SummarySection() {
  const { form, refs, handleKeyDown, isEdit, localTotals, manualQuote } = useOrderForm();
  const { fmt } = useCurrency();
  const t = useMessages(orderFormMessages);
  const r = useMessages(resourceMessages);
  const rates = useShippingRates();
  const shippingCharge = useWatch({ control: form.control, name: "shippingCharge" });
  const [rateId, setRateId] = React.useState<string>(CUSTOM_CHARGE);
  // The picked rate stays shown only while the charge still equals its fee.
  const pickedRate = rates.find((rate) => rate.id === rateId && rate.fee === Number(shippingCharge));

  const quote = manualQuote.isCurrent ? manualQuote.data : null;
  const subtotal = quote?.subtotalAmount ?? localTotals.subtotal;
  const shipping = quote?.shippingAmount ?? localTotals.shipping;
  const discount = quote?.discountAmount ?? localTotals.discount;
  const discountLimit = manualQuote.discountLimit;
  const discountNeedsCorrection = discountLimit?.exceeded === true;
  const shippingInvalid = shipping < 0;
  const total = discountNeedsCorrection || shippingInvalid
    ? null
    : quote?.totalAmount ?? localTotals.total;

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
          {rates.length > 0 ? (
            <div className="space-y-2">
              <Label htmlFor="order-delivery-method">{t("deliveryMethod")}</Label>
              <Select
                value={pickedRate?.id ?? CUSTOM_CHARGE}
                onValueChange={(value) => {
                  setRateId(value);
                  const rate = rates.find((candidate) => candidate.id === value);
                  if (rate) {
                    form.setValue("shippingCharge", rate.fee, { shouldDirty: true, shouldValidate: true });
                  } else {
                    refs.shippingChargeRef.current?.focus();
                  }
                }}
              >
                <SelectTrigger id="order-delivery-method" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {rates.map((rate) => (
                    <SelectItem key={rate.id} value={rate.id}>
                      {rate.name} · {fmt(rate.fee)}
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM_CHARGE}>{t("customCharge")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}

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
                    min={0}
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
                    min={0}
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

        {manualQuote.errorMessage ? (
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

        {/* Only the order-level discount is here; line totals add up to the subtotal. */}
        <dl className="space-y-2 border-t pt-4 text-body tabular-nums">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t("subtotal")}</dt>
            <dd>{fmt(subtotal)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{t("deliveryCharge")}</dt>
            <dd>{shippingInvalid ? "—" : fmt(shipping)}</dd>
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
              {total != null
                ? fmt(total)
                : discountNeedsCorrection ? t("fixDiscount") : t("fixDeliveryCharge")}
            </dd>
          </div>
        </dl>

        {/* Always one line tall so the card does not jump while the total loads. */}
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
      </CardContent>
    </Card>
  );
}
