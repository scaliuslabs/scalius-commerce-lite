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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../../ui/tooltip";
import { Button } from "../../../ui/button";
import { Percent, RefreshCw } from "lucide-react";
import type { FormValues } from "./types";
import { generateDiscountCode } from "../utils";

interface DiscountDetailsSectionProps {
  form: UseFormReturn<FormValues>;
  symbol: string;
}

export function DiscountDetailsSection({ form, symbol }: DiscountDetailsSectionProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Discount Details</CardTitle>
        <CardDescription>
          Define the code, type, and value for this product discount.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-4">
        <FormField
          control={form.control}
          name="code"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Discount Code *</FormLabel>
              <FormControl>
                <div className="flex gap-2">
                  <Input
                    placeholder="e.g., SUMMER20OFF"
                    {...field}
                    onChange={(e) =>
                      field.onChange(e.target.value.toUpperCase())
                    }
                    className="font-mono tracking-wider"
                  />
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="shrink-0"
                          onClick={() => {
                            const code = generateDiscountCode();
                            field.onChange(code);
                          }}
                        >
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>Generate random code</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </FormControl>
              <FormDescription>
                Customers enter this at checkout. Must be unique.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="valueType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Discount Type *</FormLabel>
                <Select
                  onValueChange={field.onChange}
                  defaultValue={field.value}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select discount type" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent className="rounded-xl bg-background">
                    <SelectItem value="percentage">Percentage</SelectItem>
                    <SelectItem value="fixed_amount">
                      Fixed Amount ({symbol})
                    </SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="discountValue"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Discount Value *</FormLabel>
                <FormControl>
                  <div className="relative">
                    <Input
                      type="number"
                      step="any"
                      placeholder={
                        form.watch("valueType") === "percentage"
                          ? "e.g., 15 for 15%"
                          : `e.g., 500 for ${symbol}500`
                      }
                      {...field}
                      onChange={(e) => {
                        const value = parseFloat(e.target.value);
                        field.onChange(isNaN(value) ? "" : value);
                      }}
                      value={field.value === 0 ? "" : field.value}
                    />
                    <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                      {form.watch("valueType") === "percentage" ? (
                        <Percent className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {symbol}
                        </span>
                      )}
                    </div>
                  </div>
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
