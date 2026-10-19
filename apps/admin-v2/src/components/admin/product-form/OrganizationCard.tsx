import { lazy, memo, Suspense, useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import type { UseFormReturn } from "react-hook-form";
import { ChevronsUpDown } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormField } from "@/components/ui/form";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { categoryPathLabel, indexCategories } from "@/lib/category-tree";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { categoryStatusLabel } from "./category-status-label";
import type { Category, ProductFormValues } from "./types";
import { Field, ReadOnlyValue } from "~/components/ui/field";
import { useFieldControl } from "~/components/ui/field";

interface OrganizationCardProps {
  form: UseFormReturn<ProductFormValues>;
  categories: Category[];
  readOnly?: boolean;
  /** The saved brand's name, for the picker's label. */
  brandName?: string | null;
}

// The brand search picker is loaded after the page, so it stays off the product page's first download.
const BrandPicker = lazy(() => import("./BrandPicker"));

// The category list (search, choose, create) is needed only once the picker opens, so it loads right
// after the page, and again at the first look at the trigger.
const loadCategoryPickerList = () => import("./CategoryPickerList");
void loadCategoryPickerList().catch(() => {});
const CategoryPickerList = lazy(loadCategoryPickerList);

/** Side card: the product's category (new categories start as drafts) and brand. */
export const OrganizationCard = memo(function OrganizationCard({ form, categories, brandName = null, readOnly = false }: OrganizationCardProps) {
  const t = useMessages(productMessages);
  const [availableCategories, setAvailableCategories] = useState<Category[]>(categories);
  const [brandLabel, setBrandLabel] = useState<string | null>(brandName);
  const categoryById = useMemo(() => indexCategories(categories), [categories]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("organization")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField
          control={form.control}
          name="categoryId"
          render={({ field, fieldState }) => {
            if (readOnly) {
              const category = categoryById.get(field.value);
              const status = category ? categoryStatusLabel(t, category) : null;
              const path = categoryPathLabel(field.value, categoryById);
              return <ReadOnlyValue label={t("category")} value={!field.value ? null : category ? (status ? `${path} · ${status}` : path) : t("savedValueUnavailable")} />;
            }
            return (
              <Field label={t("category")} error={fieldState.error?.message}>
                <CategoryCombobox
                  categories={availableCategories}
                  selectedId={field.value}
                  invalid={Boolean(fieldState.error)}
                  onSelect={field.onChange}
                  onCreated={(category) => {
                    setAvailableCategories((current) => [...current, category]);
                    form.setValue("categoryId", category.id, { shouldDirty: true, shouldValidate: true });
                  }}
                />
              </Field>
            );
          }}
        />
        <FormField
          control={form.control}
          name="brandId"
          render={({ field, fieldState }) => readOnly ? (
            <ReadOnlyValue label={t("brand")} value={field.value ? brandName || t("savedValueUnavailable") : null} />
          ) : (
            <Field id="product-brand" label={t("brand")} error={fieldState.error?.message}>
              <Suspense fallback={<Skeleton className="h-11 w-full sm:h-9" />}>
                <BrandPicker
                  id="product-brand"
                  value={field.value}
                  label={brandLabel}
                  onChange={(value, label) => {
                    setBrandLabel(label);
                    field.onChange(value);
                  }}
                />
              </Suspense>
            </Field>
          )}
        />
      </CardContent>
    </Card>
  );
});

function CategoryCombobox({
  categories,
  selectedId,
  onSelect,
  onCreated,
  invalid = false,
}: {
  categories: Category[];
  selectedId: string;
  onSelect: (categoryId: string) => void;
  onCreated: (category: Category) => void;
  invalid?: boolean;
}) {
  const t = useMessages(productMessages);
  const [open, setOpen] = useState(false);
  const byId = useMemo(() => indexCategories(categories), [categories]);
  const selected = categories.find((category) => category.id === selectedId);
  const selectedStatus = selected ? categoryStatusLabel(t, selected) : null;
  const selectedPath = selected ? categoryPathLabel(selected.id, byId) : null;
  const selectedLabel = selectedPath ? (selectedStatus ? `${selectedPath} · ${selectedStatus}` : selectedPath) : undefined;
  // The trigger is the Category field's control: its label names it.
  const control = useFieldControl({});

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          {...control}
          aria-invalid={invalid || control["aria-invalid"] || undefined}
          className="w-full justify-between"
          onPointerEnter={() => void loadCategoryPickerList().catch(() => {})}
          onFocus={() => void loadCategoryPickerList().catch(() => {})}
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")} title={selectedLabel}>
            {selectedLabel ?? t(selectedId ? "savedValueUnavailable" : "chooseCategory")}
          </span>
          <ChevronsUpDown className="ms-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Suspense fallback={<div className="h-24" aria-hidden />}>
          <CategoryPickerList
            categories={categories}
            selectedId={selectedId}
            onSelect={onSelect}
            onCreated={onCreated}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}

