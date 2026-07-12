// src/components/admin/product-form/StatusCard.tsx
import { memo } from "react";
import type { UseFormReturn } from "react-hook-form";
import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  PRODUCT_CONDITION_DESCRIPTIONS,
  PRODUCT_CONDITION_LABELS,
  PRODUCT_CONDITION_VALUES,
} from "@scalius/shared/product-condition";
import type { ProductFormValues } from "./types";

interface StatusCardProps {
  form: UseFormReturn<ProductFormValues>;
  isEdit?: boolean;
  storefrontUrl?: string;
}

export const StatusCard = memo(function StatusCard({ form, isEdit, storefrontUrl }: StatusCardProps) {
  const isActive = form.watch("isActive");

  return (
    <Card>
      <CardHeader className="px-4 py-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Status</CardTitle>
          <Badge variant={isActive ? "default" : "secondary"} className="text-xs">
            {isActive ? "Active" : "Draft"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4 pt-0">
        <div className="divide-y rounded-lg border">
          <FormField
            control={form.control}
            name="isActive"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between gap-3 p-2.5">
                <div className="min-w-0">
                  <FormLabel className="text-xs font-medium">Published</FormLabel>
                  <FormDescription className="mt-0.5 truncate text-[11px]">
                    Visible on the storefront
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="freeDelivery"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center justify-between gap-3 p-2.5">
                <div className="min-w-0">
                  <FormLabel className="text-xs font-medium">Free delivery</FormLabel>
                  <FormDescription className="mt-0.5 truncate text-[11px]">
                    Waive product delivery fees
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch checked={field.value} onCheckedChange={field.onChange} />
                </FormControl>
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="productCondition"
          render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs font-medium">Condition</FormLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <FormControl>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Select condition" />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {PRODUCT_CONDITION_VALUES.map((condition) => (
                    <SelectItem key={condition} value={condition}>
                      {PRODUCT_CONDITION_LABELS[condition]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription className="text-[11px] leading-4">
                {PRODUCT_CONDITION_DESCRIPTIONS[field.value]}
              </FormDescription>
            </FormItem>
          )}
        />

        {isEdit && storefrontUrl && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-full text-xs"
            onClick={() => window.open(storefrontUrl, "_blank")}
          >
            <ExternalLink className="h-3 w-3 mr-1.5" />
            View on Storefront
          </Button>
        )}
      </CardContent>
    </Card>
  );
});
