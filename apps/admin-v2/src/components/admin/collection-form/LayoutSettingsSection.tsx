import React from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
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
import { Textarea } from "../../ui/textarea";
import { Switch } from "../../ui/switch";
import { X } from "lucide-react";
import { ResourceDiscoveryReadiness } from "~/components/admin/shared/ResourceDiscoveryReadiness";
import type { CollectionFormValues, Product } from "./types";
import { collectionPresentations } from "./types";
import { ProductPickerPopover } from "./ProductPickerPopover";
import { CharacterCounter } from "../../ui/character-counter";
import { CollapsibleCard } from "~/components/admin/product-form/CollapsibleCard";

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
    const collectionId = useWatch({ control: form.control, name: "id" });
    const collectionName = useWatch({ control: form.control, name: "name" });
    const metaTitle = useWatch({ control: form.control, name: "metaTitle" });
    const metaDescription = useWatch({
      control: form.control,
      name: "metaDescription",
    });
    const canonicalPath = useWatch({
      control: form.control,
      name: "canonicalPath",
    });
    const noIndex = useWatch({ control: form.control, name: "noIndex" });
    const excludeFromSitemap = useWatch({
      control: form.control,
      name: "excludeFromSitemap",
    });
    const showOnHomepage = useWatch({
      control: form.control,
      name: "config.showOnHomepage",
    });
    const isActive = useWatch({ control: form.control, name: "isActive" });

    return (
      <div className="space-y-3">
        <Card>
          <CardHeader className="px-4 py-3">
            <CardTitle className="text-sm">Status</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4 pt-0">
            <FormField
              control={form.control}
              name="isActive"
              render={({ field }) => (
                <FormItem className="flex min-h-11 flex-row items-center justify-between rounded-md border px-3 py-2">
                  <FormLabel className="text-sm font-medium">Published</FormLabel>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      className="relative before:absolute before:-inset-x-1 before:-inset-y-3 before:content-['']"
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <CollapsibleCard
          title="Search and discovery"
          summary={
            <div className="rounded-md border bg-muted/15 p-2.5">
              <p className="truncate text-xs font-medium text-foreground">
                {metaTitle?.trim() || collectionName?.trim() || "Search preview"}
              </p>
              <p className="mt-0.5 truncate text-[10px] text-emerald-700 dark:text-emerald-400">
                /collections/{collectionId || "collection-id"}
              </p>
              {metaDescription?.trim() ? (
                <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                  {metaDescription.trim()}
                </p>
              ) : null}
            </div>
          }
        >
          <FormField
            control={form.control}
            name="metaTitle"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm font-medium">Page title</FormLabel>
                <FormControl>
                  <Input
                    maxLength={70}
                    placeholder={collectionName || "Collection title"}
                    className="min-h-11 md:h-9 md:min-h-9"
                    {...field}
                    value={field.value || ""}
                    onChange={(event) => field.onChange(event.target.value || null)}
                  />
                </FormControl>
                {field.value ? (
                  <CharacterCounter
                    current={field.value.length}
                    recommended={60}
                    max={70}
                  />
                ) : null}
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="metaDescription"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm font-medium">
                  Meta description
                </FormLabel>
                <FormControl>
                  <Textarea
                    rows={3}
                    maxLength={200}
                    className="min-h-24 resize-none"
                    placeholder="Collection description"
                    {...field}
                    value={field.value || ""}
                    onChange={(event) => field.onChange(event.target.value || null)}
                  />
                </FormControl>
                {field.value ? (
                  <CharacterCounter
                    current={field.value.length}
                    recommended={160}
                    max={200}
                  />
                ) : null}
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="canonicalPath"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-sm font-medium">
                  Canonical path
                </FormLabel>
                <FormControl>
                  <Input
                    placeholder={
                      collectionId
                        ? `/collections/${collectionId}`
                        : "Leave blank until saved"
                    }
                    className="min-h-11 md:h-9 md:min-h-9"
                    {...field}
                    value={field.value || ""}
                    onChange={(event) => {
                      field.onChange(event.target.value || null);
                    }}
                  />
                </FormControl>
                <FormDescription className="text-xs leading-5">
                  Optional same-store path for a duplicate or campaign page.
                  Leave blank to use this collection page.
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
                    Keep the collection page public, but ask search engines not
                    to index it.
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    className="relative before:absolute before:-inset-x-1 before:-inset-y-3 before:content-['']"
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
                    className="relative before:absolute before:-inset-x-1 before:-inset-y-3 before:content-['']"
                  />
                </FormControl>
              </FormItem>
            )}
          />
          <ResourceDiscoveryReadiness
            kind="collection"
            id={collectionId}
            canonicalPath={canonicalPath}
            noIndex={noIndex}
            excludeFromSitemap={excludeFromSitemap}
            isActive={isActive}
          />
        </CollapsibleCard>

        <CollapsibleCard title="Homepage" defaultOpen={showOnHomepage}>
          <FormField
            control={form.control}
            name="config.showOnHomepage"
            render={({ field }) => (
              <FormItem className="flex min-h-11 flex-row items-center justify-between rounded-md border p-3">
                <div className="space-y-0.5 pr-4">
                  <FormLabel className="text-sm font-medium">
                    Show on homepage
                  </FormLabel>
                  {field.value && !isActive ? (
                    <FormDescription className="text-xs">
                      Appears after the collection is published.
                    </FormDescription>
                  ) : null}
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    className="relative before:absolute before:-inset-x-1 before:-inset-y-3 before:content-['']"
                  />
                </FormControl>
              </FormItem>
            )}
          />

          {showOnHomepage ? (
            <div className="space-y-3 border-t pt-3">
              <FormField
                control={form.control}
                name="presentation"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium">
                      Display style
                    </FormLabel>
                    <Select
                      onValueChange={(value) => {
                        field.onChange(value);
                      }}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger className="min-h-11 md:h-9 md:min-h-9">
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
                            <div className="font-medium">
                              {presentation.label}
                            </div>
                            <div className="text-xs text-gray-500">
                              {presentation.description}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="config.title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium">
                      Display title
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Homepage title"
                        maxLength={120}
                        className="min-h-11 md:h-9 md:min-h-9"
                        {...field}
                        value={field.value || ""}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="config.subtitle"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium">
                      Display subtitle
                    </FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Optional subtitle"
                        maxLength={240}
                        className="min-h-11 md:h-9 md:min-h-9"
                        {...field}
                        value={field.value || ""}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {selectedPresentation === "grid" ? (
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
                            buttonClassName="min-h-11 min-w-0 flex-1 justify-between font-normal md:h-9 md:min-h-9"
                          />
                          {field.value ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="h-11 w-11 md:h-9 md:w-9"
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
                        Pinned first in the homepage grid.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}

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
                        className="min-h-11 md:h-9 md:min-h-9"
                        {...field}
                        onChange={(event) =>
                          field.onChange(parseInt(event.target.value) || 1)
                        }
                      />
                    </FormControl>
                    <FormDescription className="text-xs">
                      1–24 products. The collection page stays paginated.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          ) : null}
        </CollapsibleCard>
      </div>
    );
  },
);
