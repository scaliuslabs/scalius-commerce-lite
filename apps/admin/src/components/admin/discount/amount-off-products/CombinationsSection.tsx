import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from "../../../ui/form";
import { Checkbox } from "../../../ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../ui/card";
import type { FormValues } from "./types";

interface CombinationsSectionProps {
  form: UseFormReturn<FormValues>;
}

export function CombinationsSection({ form }: CombinationsSectionProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Combinations</CardTitle>
        <CardDescription>
          Specify if this discount can be combined with others.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <FormField
          control={form.control}
          name="combineWithProductDiscounts"
          render={({ field }) => (
            <FormItem className="flex items-center space-x-3">
              <FormControl>
                <Checkbox
                  id="combineProduct"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
              <FormLabel
                htmlFor="combineProduct"
                className="font-normal text-sm cursor-pointer"
              >
                Combine with other product discounts
              </FormLabel>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="combineWithOrderDiscounts"
          render={({ field }) => (
            <FormItem className="flex items-center space-x-3">
              <FormControl>
                <Checkbox
                  id="combineOrder"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
              <FormLabel
                htmlFor="combineOrder"
                className="font-normal text-sm cursor-pointer"
              >
                Combine with order discounts
              </FormLabel>
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="combineWithShippingDiscounts"
          render={({ field }) => (
            <FormItem className="flex items-center space-x-3">
              <FormControl>
                <Checkbox
                  id="combineShipping"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
              <FormLabel
                htmlFor="combineShipping"
                className="font-normal text-sm cursor-pointer"
              >
                Combine with shipping discounts
              </FormLabel>
            </FormItem>
          )}
        />
      </CardContent>
    </Card>
  );
}
