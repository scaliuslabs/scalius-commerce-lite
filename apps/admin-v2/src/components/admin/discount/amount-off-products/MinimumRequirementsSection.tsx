import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../../ui/form";
import { Input } from "../../../ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../ui/card";
import type { FormValues } from "./types";
import { handleOptionalNumberChange } from "./types";

interface MinimumRequirementsSectionProps {
  form: UseFormReturn<FormValues>;
  symbol: string;
}

export function MinimumRequirementsSection({ form, symbol }: MinimumRequirementsSectionProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Minimum Requirements</CardTitle>
        <CardDescription>
          Set conditions that must be met for the discount to apply
          (optional).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-4">
        <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="minPurchaseAmount"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Minimum Purchase Amount</FormLabel>
                <FormControl>
                  <div className="relative">
                    <Input
                      type="number"
                      step="any"
                      placeholder="No minimum"
                      {...field}
                      value={field.value ?? ""}
                      onChange={(e) =>
                        handleOptionalNumberChange(e, field.onChange)
                      }
                    />
                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                      <span className="text-sm text-muted-foreground">
                        {symbol}
                      </span>
                    </div>
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="minQuantity"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Minimum Quantity of Items</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="1"
                    placeholder="No minimum"
                    {...field}
                    value={field.value ?? ""}
                    onChange={(e) =>
                      handleOptionalNumberChange(e, field.onChange, true)
                    }
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </CardContent>
    </Card>
  );
}
