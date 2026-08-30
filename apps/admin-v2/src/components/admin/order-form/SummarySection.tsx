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
import { useState, useEffect } from "react";
import {
  type OrderCalculation,
  getOrderCalculation,
  subscribe,
  updateShippingCharge,
  updateDiscountAmount,
} from "../../../store/orderStore";
import { useOrderForm } from "./OrderFormContext";
import { useCurrency } from "~/hooks/use-currency";
import { getDecimalPlaces } from "@scalius/shared/currency";
import {
  CircleCheck,
  Loader2,
  PackageCheck,
  RotateCcw,
  WalletCards,
} from "lucide-react";

export function SummarySection() {
  const { form, refs, handleKeyDown, isEdit, manualQuote } = useOrderForm();
  const { symbol, code } = useCurrency();
  const [calculations, setCalculations] = useState<OrderCalculation>(
    getOrderCalculation(),
  );

  useEffect(() => {
    return subscribe(setCalculations);
  }, []);

  const quote = !isEdit && manualQuote.isCurrent ? manualQuote.data : null;
  const decimalPlaces = quote?.decimalPlaces ?? getDecimalPlaces(code);
  const formatAmount = (amount: number, places = decimalPlaces) =>
    amount.toLocaleString(undefined, {
      minimumFractionDigits: places,
      maximumFractionDigits: places,
    });
  const subtotal = quote?.subtotalAmount ?? calculations.subtotal;
  const shipping = quote?.shippingAmount ?? calculations.shippingCharge;
  const discount = quote?.discountAmount ?? calculations.discountAmount ?? 0;
  const discountNeedsCorrection = !isEdit
    && manualQuote.discountLimit?.exceeded === true;
  const total = discountNeedsCorrection
    ? null
    : quote?.totalAmount ?? calculations.total;
  const discountGuidanceId = "manual-order-discount-guidance";
  const discountErrorId = "manual-order-discount-error";

  const removeDiscount = () => {
    form.setValue("discountAmount", null, {
      shouldDirty: true,
      shouldValidate: true,
    });
    updateDiscountAmount(null);
    refs.discountAmountRef.current?.focus();
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-base">Order Summary</CardTitle>
          <CardDescription className="text-sm">
            {isEdit
              ? "Review the unsettled order."
              : "Confirmed COD order with payment due and stock reserved."}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <FormField
              control={form.control}
              name="shippingCharge"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Shipping Charge</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder="0.00"
                      step="0.01"
                      {...field}
                      value={field.value === 0 ? "" : field.value ?? ""}
                      ref={(el) => {
                        field.ref(el);
                        refs.shippingChargeRef.current = el;
                      }}
                      onChange={(e) => {
                        const value = e.target.value ? parseFloat(e.target.value) : 0;
                        field.onChange(value);
                        updateShippingCharge(value);
                      }}
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
                  <FormLabel>Additional Discount Amount</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder="0.00"
                      step="0.01"
                      max={!isEdit
                        ? manualQuote.discountLimit?.maximumAmount
                        : undefined}
                      aria-invalid={discountNeedsCorrection || undefined}
                      aria-describedby={discountNeedsCorrection
                        ? `${discountGuidanceId} ${discountErrorId}`
                        : discountGuidanceId}
                      aria-errormessage={discountNeedsCorrection
                        ? discountErrorId
                        : undefined}
                      {...field}
                      value={field.value ?? ""}
                      ref={(el) => {
                        field.ref(el);
                        refs.discountAmountRef.current = el;
                      }}
                      onChange={(e) => {
                        const value = e.target.value ? parseFloat(e.target.value) : null;
                        field.onChange(value);
                        updateDiscountAmount(value);
                      }}
                      onKeyDown={(e) => handleKeyDown(e, refs.submitButtonRef)}
                    />
                  </FormControl>
                  <FormDescription id={discountGuidanceId}>
                    Applied on top of any item-specific discounts.
                  </FormDescription>
                  {discountNeedsCorrection && manualQuote.discountLimit && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p
                        id={discountErrorId}
                        className="text-sm font-medium text-destructive"
                        role="alert"
                      >
                        Discount can’t exceed {
                          manualQuote.discountLimit.currencyCode === code
                            ? symbol
                            : `${manualQuote.discountLimit.currencyCode} `
                        }
                        {formatAmount(
                          manualQuote.discountLimit.maximumAmount,
                          manualQuote.discountLimit.decimalPlaces,
                        )} for
                        the current items and shipping.
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 text-xs"
                        onClick={removeDiscount}
                      >
                        Remove discount
                      </Button>
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {!isEdit && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-y py-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <CircleCheck className="h-3.5 w-3.5" /> Confirmed
              </span>
              <span className="inline-flex items-center gap-1.5">
                <WalletCards className="h-3.5 w-3.5" /> COD · unpaid
              </span>
              <span className="inline-flex items-center gap-1.5">
                <PackageCheck className="h-3.5 w-3.5" /> Stock reserved
              </span>
            </div>
          )}

          {!isEdit && manualQuote.isLoading && (
            <div
              className="flex items-center gap-2 text-xs text-muted-foreground"
              aria-live="polite"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Calculating the final tax and total…
            </div>
          )}

          {!isEdit && manualQuote.errorMessage && (
            <div
              className="flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2"
              role="alert"
            >
              <p className="min-w-0 text-xs text-destructive">
                {manualQuote.errorMessage}
              </p>
              {manualQuote.canRetry && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 text-xs"
                  onClick={manualQuote.retry}
                >
                  <RotateCcw className="mr-1.5 h-3 w-3" /> Retry
                </Button>
              )}
            </div>
          )}

          <div className="rounded-md border p-3 bg-muted/20">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal</span>
                <span className="font-medium">
                  {symbol}
                  {formatAmount(subtotal)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Shipping</span>
                <span className="font-medium">
                  {symbol}
                  {formatAmount(shipping)}
                </span>
              </div>
              {discount > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Additional discount</span>
                  <span className="font-medium text-destructive">
                    -{symbol}
                    {formatAmount(discount)}
                  </span>
                </div>
              )}
              {quote && (quote.taxEnabled || quote.taxAmount > 0) && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">
                    {quote.taxLabel}
                    {quote.pricesIncludeTax ? " · included" : ""}
                  </span>
                  <span className="font-medium">
                    {symbol}
                    {formatAmount(quote.taxAmount)}
                  </span>
                </div>
              )}
              <div className="flex justify-between border-t pt-2 mt-2">
                <span className="text-base font-semibold">Total</span>
                {total == null ? (
                  <span className="text-sm font-semibold text-destructive">
                    Needs correction
                  </span>
                ) : (
                  <span className="text-lg font-bold">
                    {symbol}
                    {formatAmount(total)}
                  </span>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

    </>
  );
}
