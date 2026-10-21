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
import { FormField } from "~/components/ui/form";
import { MoneyInput } from "~/components/admin/shared/MoneyInput";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Button } from "~/components/ui/button";
import { Loader2, RotateCcw } from "lucide-react";
import { useOrderForm } from "./OrderFormContext";
import { isPhysicalLine } from "./order-line-properties";
import { useCurrency } from "~/hooks/use-currency";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData, type ApiResult } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";
import { resourceMessages } from "~/i18n/resource";
import { resolveDestinationZoneId } from "@scalius/core/modules/delivery/browser";
import { Field, FieldRow } from "~/components/ui/field";

const discountGuidanceId = "manual-order-discount-guidance";
const discountErrorId = "manual-order-discount-error";
const CUSTOM_CHARGE = "custom";
type DeliveryZones = ApiResult<typeof getApiV1AdminSettingsShippingMethods>;
type DeliveryAddress = {
  /** Absent or BD: Bangladesh, by its City/Thana/Area. */
  countryCode?: string | null;
  city: string;
  zone: string;
  area: string | null;
  adminArea?: string | null;
  postalCode?: string | null;
};

/**
 * The delivery methods checkout offers for an address: the rates of the
 * shipping zone it belongs to (the most specific match: Bangladesh area,
 * thana or city, then postal prefix, admin area, country; checkout's own
 * rule), plus local pickup. Without a destination, every rate.
 */
export function deliveryRatesForAddress(data: DeliveryZones | undefined, address: DeliveryAddress) {
  if (!data) return [];
  const named = (zone: DeliveryZones["zones"][number]) =>
    zone.rates.map((rate) => ({ ...rate, name: `${zone.name} · ${rate.name}` }));
  const pickup = data.pickup.rates;
  const active = (rate: (typeof pickup)[number]) => rate.isActive;
  const country = address.countryCode?.trim().toUpperCase() || "BD";
  if (country === "BD" && !address.city) return [...data.zones.flatMap(named), ...pickup].filter(active);
  const zoneId = resolveDestinationZoneId(
    { countryCode: country, city: address.city, zone: address.zone, area: address.area, adminArea: address.adminArea, postalCode: address.postalCode },
    {
      locations: data.zones.flatMap((zone) => zone.locations.map((location) => ({ id: location.id, deliveryZoneId: zone.id }))),
      regions: data.zones.flatMap((zone) => zone.regions.map((region) => ({ ...region, zoneId: zone.id }))),
    },
  );
  const zone = data.zones.find((candidate) => candidate.id === zoneId);
  return [...(zone ? named(zone) : []), ...pickup].filter(active);
}

/**
 * The store's delivery zones for the delivery method picker; none without
 * access. Same key as Settings → Shipping, so both share one cache entry.
 */
function useDeliveryZones() {
  const { hasPermission } = usePermissions();
  return useQuery({
    queryKey: queryKeys.settings.shippingMethods(),
    queryFn: () => apiData(getApiV1AdminSettingsShippingMethods()),
    enabled: hasPermission(ADMIN_PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW),
    staleTime: 5 * 60 * 1000,
    retry: false,
  }).data;
}

/** Payment card: delivery charge, discount and the order total from the server quote. */
export function SummarySection() {
  const { form, refs, handleKeyDown, isEdit, savedShippingMethod, localTotals, manualQuote } = useOrderForm();
  const { fmt, code } = useCurrency();
  const t = useMessages(orderFormMessages);
  const r = useMessages(resourceMessages);
  const [city, zone, area, shippingMethodId, items, countryCode, adminArea, postalCode, paymentMethod] = useWatch({
    control: form.control,
    name: ["city", "zone", "area", "shippingMethodId", "items", "shippingCountryCode", "shippingAdminArea", "shippingPostalCode", "paymentMethod"],
  });
  // Only physical lines need a delivery method; a cart of services has none (and no charge).
  const hasPhysical = !items?.length || items.some(isPhysicalLine);
  const zones = useDeliveryZones();
  const rates = deliveryRatesForAddress(zones, { countryCode, city, zone, area, adminArea, postalCode });
  // Bangladesh is a destination once its city is chosen; another country by itself.
  const abroad = (countryCode?.trim().toUpperCase() || "BD") !== "BD";
  const hasDestination = abroad || Boolean(city);
  const pickedRate = rates.find((rate) => rate.id === shippingMethodId);
  // Editing: the method the order was placed with stays named, even when this address no longer offers it.
  const savedOption = savedShippingMethod && !rates.some((rate) => rate.id === savedShippingMethod.id)
    ? savedShippingMethod
    : null;
  const methodValue = pickedRate?.id ?? (savedOption && shippingMethodId === savedOption.id ? savedOption.id : CUSTOM_CHARGE);
  // Once the merchant sets their own charge, a new address doesn't replace it.
  const customChosen = React.useRef(false);
  const offeredKey = rates.map((rate) => rate.id).join();

  const pickRate = React.useCallback((rate: (typeof rates)[number] | undefined) => {
    const set = { shouldDirty: true, shouldValidate: true };
    form.setValue("shippingMethodId", rate?.id ?? null, set);
    // A pickup rate means no address; a custom charge is a delivery.
    form.setValue("shippingMethodKind", rate?.kind ?? null, set);
    if (rate) form.setValue("shippingCharge", rate.fee, set);
  }, [form]);

  // Nothing physical left in the order: no delivery method and no delivery charge.
  React.useEffect(() => {
    if (hasPhysical) return;
    const set = { shouldDirty: true, shouldValidate: true };
    if (form.getValues("shippingMethodId") !== null) form.setValue("shippingMethodId", null, set);
    if (form.getValues("shippingMethodKind") != null) form.setValue("shippingMethodKind", null, set);
    if (form.getValues("shippingCharge") !== 0) form.setValue("shippingCharge", 0, set);
  }, [form, hasPhysical]);

  // New orders: choosing the address picks its zone's delivery method and charge, as checkout does.
  React.useEffect(() => {
    // Waits for the zones, so a method carried over from a checkout isn't dropped while they load.
    if (isEdit || !hasDestination || !zones || customChosen.current || !hasPhysical) return;
    const current = form.getValues("shippingMethodId");
    if (current && rates.some((rate) => rate.id === current)) return;
    const suggested = rates.find((rate) => rate.kind === "delivery");
    if (suggested || current) pickRate(suggested);
    // Rates are compared by id (offeredKey); the list itself is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, hasDestination, zones, offeredKey, form, pickRate, hasPhysical]);

  const quote = manualQuote.isCurrent ? manualQuote.data : null;
  const subtotal = quote?.subtotalAmount ?? localTotals.subtotal;
  const shipping = quote?.shippingAmount ?? localTotals.shipping;
  const discount = quote?.discountAmount ?? localTotals.discount;
  // Installed apps' discounts come after the staff discount; the quote's discount includes both.
  const appDiscounts = quote?.appDiscounts ?? [];
  const toMinor = (amount: number) => Math.round(amount * 10 ** (quote?.decimalPlaces ?? 2));
  const staffDiscount = appDiscounts.length === 0
    ? discount
    : Math.max(0, toMinor(discount) - appDiscounts.reduce((sum, entry) => sum + toMinor(entry.amount) + toMinor(entry.shippingAmount), 0))
      / 10 ** (quote?.decimalPlaces ?? 2);
  const ruleErrors = manualQuote.ruleErrors ?? null;
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
        {isEdit ? null : (
          <CardDescription>
            {t(paymentMethod === "net_terms" ? "invoiceNote" : paymentMethod === "paid" ? "paidNote" : "codNote")}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {hasPhysical ? null : <p className="text-body text-muted-foreground">{t("noDeliveryNeeded")}</p>}
        <FieldRow>
          {hasPhysical && (rates.length > 0 || savedOption) ? (
            <Field id="order-delivery-method" label={t("deliveryMethod")}>
              <SearchableSelect
                id="order-delivery-method"
                triggerClassName="w-full"
                value={methodValue}
                onValueChange={(value) => {
                  if (savedOption && value === savedOption.id) {
                    customChosen.current = false;
                    form.setValue("shippingMethodId", value, { shouldDirty: true });
                    form.setValue("shippingMethodKind", savedOption.kind ?? null, { shouldDirty: true, shouldValidate: true });
                    return;
                  }
                  const rate = rates.find((candidate) => candidate.id === value);
                  customChosen.current = !rate;
                  pickRate(rate);
                  if (!rate) refs.shippingChargeRef.current?.focus();
                }}
                options={[
                  ...rates.map((rate) => ({
                    value: rate.id,
                    label: `${rate.name} · ${fmt(rate.fee)}`,
                    ...(rate.kind === "pickup" ? { description: rate.pickupAddress ? t("pickupAt", { address: rate.pickupAddress }) : t("pickup") } : {}),
                  })),
                  ...(savedOption ? [{ value: savedOption.id, label: savedOption.name }] : []),
                  { value: CUSTOM_CHARGE, label: t("customCharge") },
                ]}
              />
            </Field>
          ) : null}

          {hasPhysical ? <FormField
            control={form.control}
            name="shippingCharge"
            render={({ field, fieldState }) => (
              <Field label={t("deliveryCharge")} error={fieldState.error?.message}>
                <MoneyInput
                  currencyCode={code}
                  placeholder="0"
                  name={field.name}
                  disabled={field.disabled}
                  onBlur={field.onBlur}
                  value={field.value === 0 ? null : field.value}
                  ref={(el) => {
                    field.ref(el);
                    refs.shippingChargeRef.current = el;
                  }}
                  onValueChange={(value) => {
                    // A typed charge is a custom charge, delivered to the address.
                    customChosen.current = true;
                    form.setValue("shippingMethodId", null, { shouldDirty: true });
                    form.setValue("shippingMethodKind", null, { shouldDirty: true, shouldValidate: true });
                    field.onChange(value ?? 0);
                  }}
                  onKeyDown={(e) => handleKeyDown(e, refs.discountAmountRef)}
                />
              </Field>
            )}
          /> : null}

          <FormField
            control={form.control}
            name="discountAmount"
            render={({ field, fieldState }) => (
              <Field label={t("discount")} help={t("discountHelp")} error={fieldState.error?.message}>
                <MoneyInput
                  currencyCode={code}
                  placeholder="0"
                  aria-invalid={discountNeedsCorrection || undefined}
                  aria-describedby={discountNeedsCorrection
                    ? `${discountGuidanceId} ${discountErrorId}`
                    : discountGuidanceId}
                  aria-errormessage={discountNeedsCorrection ? discountErrorId : undefined}
                  name={field.name}
                  disabled={field.disabled}
                  onBlur={field.onBlur}
                  value={field.value}
                  ref={(el) => {
                    field.ref(el);
                    refs.discountAmountRef.current = el;
                  }}
                  onValueChange={field.onChange}
                  onKeyDown={(e) => handleKeyDown(e)}
                />
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
              </Field>
            )}
          />
        </FieldRow>

        {ruleErrors ? (
          <Alert variant="destructive">
            <AlertTitle>{t("appRulesTitle")}</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 ps-4">
                {ruleErrors.map((error, position) => {
                  const name = error.index === null ? null : items?.[error.index]?.name;
                  return (
                    <li key={`${error.index ?? "order"}:${error.code}:${position}`}>
                      {name ? t("appRuleOnLine", { name, message: error.message }) : error.message}
                    </li>
                  );
                })}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

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
          {hasPhysical ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t("deliveryCharge")}</dt>
              <dd>{shippingInvalid ? "—" : fmt(shipping)}</dd>
            </div>
          ) : null}
          {staffDiscount > 0 ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t("discount")}</dt>
              <dd>−{fmt(staffDiscount)}</dd>
            </div>
          ) : null}
          {appDiscounts.map((entry, position) => (
            <div key={`${entry.appId}:${position}`} className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t("appDiscount", { title: entry.title, app: entry.appName })}</dt>
              <dd>−{fmt(entry.amount + entry.shippingAmount)}</dd>
            </div>
          ))}
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
