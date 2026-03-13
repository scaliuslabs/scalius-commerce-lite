// src/components/admin/product-form/StatusCard.tsx
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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ProductFormValues } from "./types";

interface StatusCardProps {
  form: UseFormReturn<ProductFormValues>;
  isEdit?: boolean;
  storefrontUrl?: string;
}

export function StatusCard({ form, isEdit, storefrontUrl }: StatusCardProps) {
  const isActive = form.watch("isActive");

  return (
    <Card>
      <CardHeader className="pb-3 pt-4 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Status</CardTitle>
          <Badge variant={isActive ? "default" : "secondary"} className="text-xs">
            {isActive ? "Active" : "Draft"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <FormField
          control={form.control}
          name="isActive"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <FormLabel className="text-sm font-medium">
                  Active Status
                </FormLabel>
                <FormDescription className="text-xs">
                  Product will be visible on the store
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="freeDelivery"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5">
                <FormLabel className="text-sm font-medium">
                  Free Delivery
                </FormLabel>
                <FormDescription className="text-xs">
                  Offer free delivery for this product
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItem>
          )}
        />

        {isEdit && storefrontUrl && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full text-xs"
            onClick={() => window.open(storefrontUrl, "_blank")}
          >
            <ExternalLink className="h-3 w-3 mr-1.5" />
            View on Storefront
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
