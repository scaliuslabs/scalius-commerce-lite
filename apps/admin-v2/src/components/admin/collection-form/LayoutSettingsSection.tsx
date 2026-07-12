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
import { ResourceDiscoveryReadiness } from "~/components/admin/shared/ResourceDiscoveryReadiness";
import type { CollectionFormValues, Product } from "./types";
import { collectionPresentations } from "./types";
import { ProductPickerPopover } from "./ProductPickerPopover";

const PENDING_PRODUCT_LABEL = "Loading product label...";

interface LayoutSettingsSectionProps {
  form: UseFormReturn<CollectionFormValues>;
  selectedPresentation: "grid" | "carousel";
  knownProducts: Product[];
  selectedCategoryIds: string[];
  onProductDiscovered: (product: Product) => void;
}

export const LayoutSettingsSection = React.memo(
  function LayoutSettingsSection({
    form,
    selectedPresentation,
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
                      Published
                    </FormLabel>
                    <FormDescription className="text-xs">
                      Visible on the storefront and eligible for homepage display
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
              name="canonicalPath"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium">
                    Canonical Path
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder={
                        form.watch("id")
                          ? `/collections/${form.watch("id")}`
                          : "Leave blank until saved"
                      }
                      {...field}
                      value={field.value || ""}
                      onChange={(event) => {
                        field.onChange(event.target.value || null);
                      }}
                    />
                  </FormControl>
                  <FormDescription className="text-xs">
                    Collections are served by ID. Leave blank unless you need the exact saved collection route.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="noIndex"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <FormLabel className="text-sm font-medium">
                      Prevent search indexing
                    </FormLabel>
                    <FormDescription className="text-xs">
                      Keep the collection page public, but ask search engines not to index it.
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
              name="excludeFromSitemap"
              render={({ field }) => (
                <FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <FormLabel className="text-sm font-medium">
                      Hide from sitemap
                    </FormLabel>
                    <FormDescription className="text-xs">
                      Keep it public, but remove it from collections sitemap XML.
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
            <ResourceDiscoveryReadiness
              kind="collection"
              id={form.watch("id")}
              canonicalPath={form.watch("canonicalPath")}
              noIndex={form.watch("noIndex")}
              excludeFromSitemap={form.watch("excludeFromSitemap")}
              isActive={form.watch("isActive")}
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
              name="presentation"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-sm font-medium">
                    Display Style
                  </FormLabel>
                  <Select
                    onValueChange={(value) => {
                      field.onChange(value);
                    }}
                    value={field.value}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a display style" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="rounded-xl bg-background">
                      {collectionPresentations.map((presentation) => (
                        <SelectItem
                          key={presentation.value}
                          value={presentation.value}
                          className="flex flex-col items-start py-2"
                        >
                          <div className="font-medium">{presentation.label}</div>
                          <div className="text-xs text-gray-500">
                            {presentation.description}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription className="text-xs">
                    Content source and display style are independent.
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
                      maxLength={120}
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
                      maxLength={240}
                      {...field}
                      value={field.value || ""}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Featured product is available only in the grid presentation. */}
            {selectedPresentation === "grid" && (
              <FormField
                control={form.control}
                name="config.featuredProductId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium">
                      Lead product
                    </FormLabel>
                    <FormControl>
                      <div className="flex gap-2">
                        <ProductPickerPopover
                          triggerLabel={
                            field.value
                              ? productsById.get(field.value)?.name ||
                                PENDING_PRODUCT_LABEL
                              : "Select a lead product"
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
                              Clear lead product
                            </span>
                          </Button>
                        ) : null}
                      </div>
                    </FormControl>
                    <FormDescription className="text-xs">
                      Placed first in this homepage grid, even when it is outside the collection membership.
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
                    Homepage product limit
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
                    Products shown in this homepage section (1-24). The collection page remains paginated.
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
