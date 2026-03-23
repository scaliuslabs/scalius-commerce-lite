import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../../ui/form";
import { Input } from "../../../ui/input";
import { Switch } from "../../../ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../ui/card";
import type { FormValues } from "./types";
import { handleOptionalNumberChange } from "./types";

interface UsageLimitsSectionProps {
  form: UseFormReturn<FormValues>;
}

export function UsageLimitsSection({ form }: UsageLimitsSectionProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage Limits</CardTitle>
        <CardDescription>
          Control how many times the discount can be used (optional).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-4">
        <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="maxUsesPerOrder"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Maximum Uses Per Order</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="1"
                    placeholder="Unlimited"
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

          <FormField
            control={form.control}
            name="maxUses"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Total Usage Limit</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    step="1"
                    placeholder="Unlimited"
                    {...field}
                    value={field.value ?? ""}
                    onChange={(e) =>
                      handleOptionalNumberChange(e, field.onChange, true)
                    }
                  />
                </FormControl>
                <FormDescription>
                  Across all customers and orders.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="limitOnePerCustomer"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between rounded-lg border bg-background p-4">
              <div className="space-y-0.5">
                <FormLabel className="text-base">
                  Limit to one use per customer
                </FormLabel>
                <FormDescription>
                  Prevent customers from using the code multiple times.
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  aria-label="Limit one per customer toggle"
                />
              </FormControl>
            </FormItem>
          )}
        />
      </CardContent>
    </Card>
  );
}
