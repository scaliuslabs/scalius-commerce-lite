import React from "react";
import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../ui/form";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import { X } from "lucide-react";
import type { CollectionFormValues, Product } from "./types";
import { collectionTypes } from "./types";
import { ProductPickerPopover } from "./ProductPickerPopover";

interface LayoutSettingsSectionProps {
  form: UseFormReturn<CollectionFormValues>;
  selectedType: "manual" | "dynamic";
  knownProducts: Product[];
  selectedCategoryIds: string[];
  onProductDiscovered: (product: Product) => void;
}

export const LayoutSettingsSection = React.memo(
  function LayoutSettingsSection({
    form,
    selectedType,
    knownProducts,
    selectedCategoryIds,
    onProductDiscovered,
  }: LayoutSettingsSectionProps) {
    const productsById = React.useMemo(
      () => new Map(knownProducts.map((product) => [product.id, product])),
      [knownProducts],
    );

    return (
      <div className="space-y-3">
        {/* Status Card */}
        <Card>
          <CardHeader className="pb-3 pt-4 px-4">
            <CardTitle className="text-base">Status</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-3">
            <FormField
              control={form.control}
              name="isActive"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <FormLabel className="text-sm font-medium">
                      Active
                    </FormLabel>
                    <FormDescription className="text-xs">
                      Visible on the store
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
          </CardContent>
        </Card>

        {/* Display Settings Card */}
        <Card>
          <CardHeader className="pb-3 pt-4 px-4">
            <CardTitle className="text-base">Display Settings</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 space-y-3">
            {/* Display Style */}
            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium">
                    Display Style
                  </FormLabel>
                  <Select
                    onValueChange={(value) => {
                      field.onChange(value);
                    }}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a display style" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="rounded-xl bg-background">
                      {collectionTypes.map((type) => (
                        <SelectItem
                          key={type.value}
                          value={type.value}
                          className="flex flex-col items-start py-2"
                        >
                          <div className="font-medium">{type.label}</div>
                          <div className="text-xs text-gray-500">
                            {type.description}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription className="text-xs">
                    This only affects how products are displayed on the
                    storefront
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Display Title */}
            <FormField
              control={form.control}
              name="config.title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium">
                    Display Title
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Enter display title"
                      {...field}
                      value={field.value || ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Display Subtitle */}
            <FormField
              control={form.control}
              name="config.subtitle"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium">
                    Display Subtitle
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Enter display subtitle"
                      {...field}
                      value={field.value || ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Featured Product (conditional on manual type) */}
            {selectedType === "manual" && (
              <FormField
                control={form.control}
                name="config.featuredProductId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium">
                      Featured Product
                    </FormLabel>
                    <FormControl>
                      <div className="flex gap-2">
                        <ProductPickerPopover
                          triggerLabel={
                            field.value
                              ? productsById.get(field.value)?.name || field.value
                              : "Select a featured product"
                          }
                          selectedCategoryIds={selectedCategoryIds}
                          onSelectProduct={(product) => {
                            onProductDiscovered(product);
                            field.onChange(product.id);
                          }}
                          buttonClassName="min-w-0 flex-1 justify-between font-normal"
                        />
                        {field.value ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            onClick={() => field.onChange(undefined)}
                          >
                            <X className="h-4 w-4" />
                            <span className="sr-only">
                              Clear featured product
                            </span>
                          </Button>
                        ) : null}
                      </div>
                    </FormControl>
                    <FormDescription className="text-xs">
                      Displayed prominently in Collection Style 1
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Max Products */}
            <FormField
              control={form.control}
              name="config.maxProducts"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium">
                    Maximum Products
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      max={24}
                      {...field}
                      onChange={(e) =>
                        field.onChange(parseInt(e.target.value) || 1)
                      }
                    />
                  </FormControl>
                  <FormDescription className="text-xs">
                    Maximum number of products to display (1-24)
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>
      </div>
    );
  },
);
