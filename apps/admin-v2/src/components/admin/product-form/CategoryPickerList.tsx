import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Plus } from "lucide-react";
import { toast } from "~/lib/toast";
import { cn } from "@scalius/shared/utils";
import { postApiV1AdminCategories } from "@scalius/api-client/sdk";
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
import { categoryStatusLabel } from "./category-status-label";
import type { Category } from "./types";

/**
 * The category picker's list: search, choose, or create a category by name.
 * The Organization card loads it right after the page and again at the first
 * look at the trigger, so it stays off the product page's first download.
 */
export default function CategoryPickerList({
  categories,
  selectedId,
  onSelect,
  onCreated,
  onClose,
}: {
  categories: Category[];
  selectedId: string;
  onSelect: (categoryId: string) => void;
  onCreated: (category: Category) => void;
  onClose: () => void;
}) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const [search, setSearch] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const name = search.trim();

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
      onCreated({ id: data.category.id, name, status: data.category.status });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.categories.list() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.categories.formOptions() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.collections.categoryOptions() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.products.stats() }),
      ]);
      toast.success(t("categoryCreated"), { description: t("categoryCreatedHint") });
      onClose();
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
  const filtered = ordered.filter((category) => pathOf(category).toLowerCase().includes(search.toLowerCase()));

  return (
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
                  onClose();
                }}
              >
                <Check className="me-2 h-4 w-4 opacity-0" />
                <span className="flex-1 text-muted-foreground">{t("noCategory")}</span>
              </CommandItem>
            ) : null}
            {filtered.map((category) => (
              <CommandItem
                key={category.id}
                value={category.id}
                onSelect={() => {
                  onSelect(category.id);
                  onClose();
                }}
              >
                <Check className={cn("me-2 h-4 w-4", selectedId === category.id ? "opacity-100" : "opacity-0")} />
                <span className="flex-1">{pathOf(category)}</span>
                {categoryStatusLabel(t, category) ? (
                  <span className="text-body text-muted-foreground">{categoryStatusLabel(t, category)}</span>
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
                {isCreating ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <Plus className="me-2 h-4 w-4" />}
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
  );
}
