import React from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { FormField } from "~/components/ui/form";
import { Input } from "~/components/ui/input";
import { NumberInput } from "~/components/ui/number-input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { collectionFormMessages } from "~/i18n/collection-form";
import type { CollectionFormInput, CollectionFormValues, Product } from "./types";
import { ProductPickerPopover } from "./ProductPickerPopover";
import { Field } from "~/components/ui/field";

interface LayoutSettingsSectionProps {
  form: UseFormReturn<CollectionFormInput, unknown, CollectionFormValues>;
  knownProducts: Product[];
  /** Automatic collections limit the featured product to these categories. */
  selectedCategoryIds: string[];
  onProductDiscovered: (product: Product) => void;
}

/** The side column: status, then how the collection looks wherever the store shows it. */
export const LayoutSettingsSection = React.memo(function LayoutSettingsSection({
  form,
  knownProducts,
  selectedCategoryIds,
  onProductDiscovered,
}: LayoutSettingsSectionProps) {
  const t = useMessages(collectionFormMessages);
  const [name, presentation] = useWatch({
    control: form.control,
    name: ["name", "presentation"],
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
              <Field help={t(field.value ? "activeHelp" : "draftHelp")}>
                <SearchableSelect
                  triggerRef={field.ref}
                  onBlur={field.onBlur}
                  value={field.value ? "active" : "inactive"}
                  onValueChange={(value) => field.onChange(value === "active")}
                  ariaLabel={t("status")}
                  triggerClassName="w-full"
                  options={[{ value: "active", label: t("active") }, { value: "inactive", label: t("draft") }]}
                />
              </Field>
            )}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("display")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FormField
            control={form.control}
            name="presentation"
            render={({ field }) => (
              <Field label={t("layout")}>
                <SearchableSelect
                  value={field.value} onValueChange={field.onChange}
                  triggerRef={field.ref}
                  onBlur={field.onBlur}
                  triggerClassName="w-full"
                  options={[{ value: "grid", label: t("grid") }, { value: "carousel", label: t("carousel") }]}
                />
              </Field>
            )}
          />
          <FormField
            control={form.control}
            name="config.title"
            render={({ field, fieldState }) => (
              <Field label={t("heading")} error={fieldState.error?.message}>
                <Input maxLength={120} placeholder={name} {...field} value={field.value ?? ""} />
              </Field>
            )}
          />
          <FormField
            control={form.control}
            name="config.subtitle"
            render={({ field, fieldState }) => (
              <Field label={t("subheading")} error={fieldState.error?.message}>
                <Input maxLength={240} {...field} value={field.value ?? ""} />
              </Field>
            )}
          />
          {presentation === "grid" ? (
            <FormField
              control={form.control}
              name="config.featuredProductId"
              render={({ field, fieldState }) => (
                <Field label={t("featuredProduct")} help={t("featuredProductHelp")} error={fieldState.error?.message}>
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
                </Field>
              )}
            />
          ) : null}
          <FormField
            control={form.control}
            name="config.maxProducts"
            render={({ field, fieldState }) => (
              <Field label={t("productsShown")} help={t("productsShownHelp")} error={fieldState.error?.message}>
                <NumberInput
                  integer
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={field.value}
                  onValueChange={(value) => field.onChange(value ?? Number.NaN)}
                />
              </Field>
            )}
          />
        </CardContent>
      </Card>
    </div>
  );
});
