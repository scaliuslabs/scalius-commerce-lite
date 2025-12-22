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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OrderStatus } from "@/db/schema";
import { useStore } from "@nanostores/react";
import {
  orderCalculations,
  updateShippingCharge,
  updateDiscountAmount,
} from "../../../store/orderStore";
import { useOrderForm } from "./OrderFormContext";

export function SummarySection() {
  const { form, isEdit, refs, handleKeyDown } = useOrderForm();
  const calculations = useStore(orderCalculations);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Order Summary</CardTitle>
          <CardDescription>Review and finalize the order.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
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
                      onKeyDown={(e) =>
                        handleKeyDown(e, isEdit ? refs.statusButtonRef : refs.submitButtonRef)
                      }
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
                  ৳
                  {calculations.subtotal.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Shipping Charge:</span>
                <span className="font-medium">
                  ৳
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
                    -৳
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
                  ৳
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

      {isEdit && (
        <Card>
          <CardHeader>
            <CardTitle>Order Status</CardTitle>
            <CardDescription>Update the current status of the order.</CardDescription>
          </CardHeader>
          <CardContent>
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Status</FormLabel>
                  <Select
                    onValueChange={(value) => {
                      field.onChange(value);
                      setTimeout(() => refs.submitButtonRef.current?.focus(), 100);
                    }}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger ref={refs.statusButtonRef} className="w-full">
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="rounded-xl bg-background">
                      {Object.values(OrderStatus).map((status) => (
                        <SelectItem key={status} value={status}>
                          {status.charAt(0).toUpperCase() +
                            status.slice(1).toLowerCase().replace("_", " ")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}