import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { useState, useEffect } from "react";
import {
  type OrderCalculation,
  getOrderCalculation,
  subscribe,
  updateShippingCharge,
  updateDiscountAmount,
} from "../../../store/orderStore";
import { useOrderForm } from "./OrderFormContext";
import { useCurrency } from "@/hooks/use-currency";

export function SummarySection() {
  const { form, refs, handleKeyDown } = useOrderForm();
  const { symbol } = useCurrency();
  const [calculations, setCalculations] = useState<OrderCalculation>(getOrderCalculation());

  useEffect(() => {
    return subscribe(setCalculations);
  }, []);

  return (
    <>
      <Card>
        <CardHeader className="pb-3 pt-4 px-4">
          <CardTitle className="text-base">Order Summary</CardTitle>
          <CardDescription className="text-sm">Review and finalize the order.</CardDescription>
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
                  <FormDescription>
                    Applied on top of any item-specific discounts.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="rounded-md border p-4 bg-muted/20">
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Subtotal:</span>
                <span className="font-medium">
                  {symbol}
                  {calculations.subtotal.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Shipping Charge:</span>
                <span className="font-medium">
                  {symbol}
                  {calculations.shippingCharge.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
              {(calculations.discountAmount ?? 0) > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Additional Discount:</span>
                  <span className="font-medium text-destructive">
                    -{symbol}
                    {(calculations.discountAmount ?? 0).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
              )}
              <div className="flex justify-between border-t pt-2 mt-2">
                <span className="text-lg font-bold">Grand Total:</span>
                <span className="text-lg font-bold">
                  {symbol}
                  {calculations.total.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

    </>
  );
}
