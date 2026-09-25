import { lazy, memo, Suspense, useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import type { UseFormReturn } from "react-hook-form";
import { Check, ChevronsUpDown, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@scalius/shared/utils";
import { postApiV1AdminCategories } from "@scalius/api-client/sdk";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { getServerFnError } from "@/lib/api-helpers";
import { apiData } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { categoriesInTreeOrder, categoryPathLabel, indexCategories } from "@/lib/category-tree";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";
import type { Category, ProductFormValues } from "./types";

interface OrganizationCardProps {
  form: UseFormReturn<ProductFormValues>;
  categories: Category[];
  /** The saved brand's name, for the picker's label. */
  brandName?: string | null;
}

// The brand search picker is loaded after the page, so it stays off the product page's first download.
const BrandPicker = lazy(() => import("./BrandPicker"));

/** Side card: the product's category (new categories start as drafts) and brand. */
export const OrganizationCard = memo(function OrganizationCard({ form, categories, brandName = null }: OrganizationCardProps) {
  const t = useMessages(productMessages);
  const [availableCategories, setAvailableCategories] = useState<Category[]>(categories);
  const [brandLabel, setBrandLabel] = useState<string | null>(brandName);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("organization")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <FormField
          control={form.control}
          name="categoryId"
          render={({ field, fieldState }) => (
            <FormItem>
              <FormLabel>{t("category")}</FormLabel>
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
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="brandId"
          render={({ field }) => (
            <FormItem>
              <FormLabel htmlFor="product-brand">{t("brand")}</FormLabel>
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
              <FormMessage />
            </FormItem>
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
  const r = useMessages(resourceMessages);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const name = search.trim();

  const statusLabel = (category: Category) =>
    category.status === "draft" ? t("statusDraft") : category.status === "internal" ? t("categoryHidden") : null;

  const handleCreate = async () => {
    if (!name) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      // The server makes the web address from the name (Bangla included) and numbers a taken one.
      const data = await apiData(postApiV1AdminCategories({
        body: {
          name,
          description: null,
          content: null,
          metaTitle: null,
          metaDescription: null,
          canonicalPath: null,
          noIndex: false,
          excludeFromSitemap: false,
          image: null,
        },
      }));
      onCreated({ id: data.id, name, status: data.status });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.categories.formOptions() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.collections.categoryOptions() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products.stats() }),
      ]);
      toast.success(t("categoryCreated"), { description: t("categoryCreatedHint") });
      setOpen(false);
      setSearch("");
    } catch (error: unknown) {
      // Said next to the Create button, where the merchant can change the name.
      setCreateError(getServerFnError(error, r("actionFailed")));
    } finally {
      setIsCreating(false);
    }
  };

  // Categories are named by their path ("Men › Shirts"), parents before children.
  const { ordered, byId } = useMemo(
    () => ({ ordered: categoriesInTreeOrder(categories), byId: indexCategories(categories) }),
    [categories],
  );
  const pathOf = (category: Category) => categoryPathLabel(category.id, byId);
  const selected = categories.find((category) => category.id === selectedId);
  const selectedStatus = selected ? statusLabel(selected) : null;
  const filtered = ordered.filter((category) => pathOf(category).toLowerCase().includes(search.toLowerCase()));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-invalid={invalid || undefined} className="w-full justify-between">
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? (selectedStatus ? `${pathOf(selected)} · ${selectedStatus}` : pathOf(selected)) : t("chooseCategory")}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder={t("searchCategories")}
            value={search}
            onValueChange={(value) => {
              setSearch(value);
              setCreateError(null);
            }}
          />
          <CommandList>
            {filtered.length > 0 || selectedId ? (
              <CommandGroup>
                {/* A category is optional (Shopify): the merchant can take it off again. */}
                {selectedId && !search ? (
                  <CommandItem
                    value="__no_category"
                    onSelect={() => {
                      onSelect("");
                      setOpen(false);
                    }}
                  >
                    <Check className="mr-2 h-4 w-4 opacity-0" />
                    <span className="flex-1 text-muted-foreground">{t("noCategory")}</span>
                  </CommandItem>
                ) : null}
                {filtered.map((category) => (
                  <CommandItem
                    key={category.id}
                    value={category.id}
                    onSelect={() => {
                      onSelect(category.id);
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <Check className={cn("mr-2 h-4 w-4", selectedId === category.id ? "opacity-100" : "opacity-0")} />
                    <span className="flex-1">{pathOf(category)}</span>
                    {statusLabel(category) ? (
                      <span className="text-body text-muted-foreground">{statusLabel(category)}</span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            <CommandEmpty>
              {name ? (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full justify-start"
                    onClick={handleCreate}
                    disabled={isCreating}
                    aria-describedby={createError ? "create-category-error" : undefined}
                  >
                    {isCreating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                    {t("createCategory", { name })}
                  </Button>
                  {createError ? (
                    <p id="create-category-error" role="alert" className="px-3 pb-2 text-body text-destructive">
                      {createError}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="py-4 text-center text-body text-muted-foreground">{t("typeToFindCategory")}</p>
              )}
            </CommandEmpty>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
