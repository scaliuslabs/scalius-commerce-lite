import React from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "~/components/ui/form";
import { Input } from "~/components/ui/input";
import { NumberInput } from "~/components/ui/number-input";
import { NativeSelect } from "~/components/ui/native-select";
import { Switch } from "~/components/ui/switch";
import { useMessages } from "~/i18n";
import { collectionFormMessages } from "~/i18n/collection-form";
import type { CollectionFormInput, CollectionFormValues, Product } from "./types";
import { ProductPickerPopover } from "./ProductPickerPopover";

interface LayoutSettingsSectionProps {
  form: UseFormReturn<CollectionFormInput, unknown, CollectionFormValues>;
  knownProducts: Product[];
  /** Automatic collections limit the featured product to these categories. */
  selectedCategoryIds: string[];
  onProductDiscovered: (product: Product) => void;
}

/** The side column: status, then how the collection shows on the homepage. */
export const LayoutSettingsSection = React.memo(function LayoutSettingsSection({
  form,
  knownProducts,
  selectedCategoryIds,
  onProductDiscovered,
}: LayoutSettingsSectionProps) {
  const t = useMessages(collectionFormMessages);
  const [name, isActive, showOnHomepage, presentation] = useWatch({
    control: form.control,
    name: ["name", "isActive", "config.showOnHomepage", "presentation"],
  });
  const productName = (id: string) => knownProducts.find((product) => product.id === id)?.name ?? t("loadingName");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("status")}</CardTitle>
        </CardHeader>
        <CardContent>
          <FormField
            control={form.control}
            name="isActive"
            rules={{ deps: ["config.productIds", "config.categoryIds"] }}
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <NativeSelect
                    value={field.value ? "active" : "inactive"}
                    onValueChange={(value) => field.onChange(value === "active")}
                    aria-label={t("status")}
                  >
                    <option value="active">{t("active")}</option>
                    <option value="inactive">{t("draft")}</option>
                  </NativeSelect>
                </FormControl>
                <FormDescription>{t(field.value ? "activeHelp" : "draftHelp")}</FormDescription>
              </FormItem>
            )}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("homepage")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormField
            control={form.control}
            name="config.showOnHomepage"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <FormLabel>{t("showOnHomepage")}</FormLabel>
                    {field.value && !isActive ? <FormDescription>{t("showsWhenActive")}</FormDescription> : null}
                  </div>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                </div>
              </FormItem>
            )}
          />

          {showOnHomepage ? (
            <div className="space-y-4 border-t pt-4">
              <FormField
                control={form.control}
                name="presentation"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("layout")}</FormLabel>
                    <FormControl>
                      <NativeSelect value={field.value} onValueChange={field.onChange}>
                        <option value="grid">{t("grid")}</option>
                        <option value="carousel">{t("carousel")}</option>
                      </NativeSelect>
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="config.title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("heading")}</FormLabel>
                    <FormControl>
                      <Input maxLength={120} placeholder={name} {...field} value={field.value ?? ""} />
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
                    <FormLabel>{t("subheading")}</FormLabel>
                    <FormControl>
                      <Input maxLength={240} {...field} value={field.value ?? ""} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {presentation === "grid" ? (
                <FormField
                  control={form.control}
                  name="config.featuredProductId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("featuredProduct")}</FormLabel>
                      <div className="flex gap-2">
                        <ProductPickerPopover
                          triggerLabel={field.value ? productName(field.value) : t("chooseProduct")}
                          selectedCategoryIds={selectedCategoryIds}
                          onSelectProduct={(product) => {
                            onProductDiscovered(product);
                            field.onChange(product.id);
                          }}
                        />
                        {field.value ? (
                          <Button type="button" variant="ghost" size="icon" aria-label={t("removeFeatured")} onClick={() => field.onChange(undefined)}>
                            <X />
                          </Button>
                        ) : null}
                      </div>
                      <FormDescription>{t("featuredProductHelp")}</FormDescription>
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
                    <FormLabel>{t("productsShown")}</FormLabel>
                    <FormControl>
                      <NumberInput
                        integer
                        name={field.name}
                        ref={field.ref}
                        onBlur={field.onBlur}
                        value={field.value}
                        onValueChange={(value) => field.onChange(value ?? Number.NaN)}
                      />
                    </FormControl>
                    <FormDescription>{t("productsShownHelp")}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
});
