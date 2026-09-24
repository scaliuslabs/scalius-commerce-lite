import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";
import {
  postApiV1AdminCollectionsByIdProducts,
  postApiV1AdminProductsBulkUpdate,
} from "@scalius/api-client/sdk";
import { normalizeCollectionConfig } from "@scalius/core/modules/collections/collection-config";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { inChunks, useResourceMutation } from "~/components/admin/resource/ResourceListPage";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { MAX_LABEL_SKUS } from "~/components/admin/barcode-labels/barcode-label-model";
import { apiData } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import { queryKeys } from "~/lib/query-keys";
import { productVariantsQueryOptions } from "~/lib/api-query-options/products";
import { categoryFormOptionsQueryOptions } from "~/lib/api-query-options/categories";
import { collectionsQueryOptions } from "~/lib/api-query-options/collections";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { resourceMessages } from "~/i18n/resource";
import type { ProductListItem } from "./product-columns";

type Picker = "category" | "addToCollection" | "removeFromCollection";

const INVALIDATE = [
  queryKeys.products.all,
  queryKeys.collections.all,
  queryKeys.categories.all,
  queryKeys.dashboard.all,
] as const;

const claims = (rows: ProductListItem[]) =>
  rows.map((row) => ({ id: row.id, expectedAggregateRevision: row.aggregateRevision }));

/**
 * The products list's bulk actions (Polaris IndexTable): two promoted status
 * actions and a menu for collections and category, each in a small dialog.
 */
export function ProductBulkActions({ rows, done }: { rows: ProductListItem[]; done: () => void }) {
  const t = useMessages(productMessages);
  const r = useMessages(resourceMessages);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [choice, setChoice] = useState("");
  const count = rows.length;
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const setStatus = useResourceMutation(async (isActive: boolean) => {
    let changed = 0;
    const skipped: string[] = [];
    await inChunks(rows, async (chunk) => {
      const result = await apiData(postApiV1AdminProductsBulkUpdate({ body: { products: claims(chunk), isActive } }));
      changed += result.products.length;
      skipped.push(...result.skipped.map((row) => row.name));
    });
    // Products without a price stay as they were; say which, and whether anything changed.
    if (skipped.length === 0) {
      toast.success(t(isActive ? "bulkActivated" : "bulkDrafted", { count: changed }));
      return;
    }
    const why = skipped.length > 1
      ? t("needsPriceMore", { name: skipped[0]!, count: skipped.length - 1 })
      : t("needsPrice", { name: skipped[0]! });
    if (changed === 0) toast.error(t("nothingChanged"), { description: why });
    else toast.warning(t("bulkActivated", { count: changed }), { description: why });
  }, INVALIDATE);
  // Setting live products as draft hides them from the store: confirm first, naming how many.
  const liveCount = rows.filter((row) => row.isActive).length;
  const [confirmDraft, setConfirmDraft] = useState(false);
  const printLabels = useMutation({
    mutationFn: async () => {
      const variantIds: string[] = [];
      for (const row of rows) {
        const { variants } = await queryClient.fetchQuery(productVariantsQueryOptions(row.id));
        variantIds.push(...variants.filter((variant) => !variant.deletedAt).map((variant) => variant.id));
        if (variantIds.length >= MAX_LABEL_SKUS) break;
      }
      return variantIds.slice(0, MAX_LABEL_SKUS);
    },
    onSuccess: (variantIds) => void navigate({ to: "/admin/inventory/labels", search: { variants: variantIds.join(",") } }),
    onError: (error) => toast.error(getServerFnError(error, r("actionFailed"))),
  });

  const { data: categoryData } = useQuery({ ...categoryFormOptionsQueryOptions(), enabled: picker === "category" });
  const { data: collectionData } = useQuery({
    ...collectionsQueryOptions({ page: 1, limit: 100 }),
    enabled: picker === "addToCollection" || picker === "removeFromCollection",
  });
  // Only hand-picked collections take products; automatic ones follow their rule.
  const manualCollections = (collectionData?.collections ?? [])
    .filter((collection) => normalizeCollectionConfig(collection.config).source === "manual");
  const options = picker === "category"
    ? (categoryData?.categories ?? []).map((category) => ({ value: category.id, label: category.name }))
    : manualCollections.map((collection) => ({ value: collection.id, label: collection.name }));

  const change = useResourceMutation(async ({ kind, id }: { kind: Picker; id: string }) => {
    if (kind === "category") {
      await inChunks(rows, (chunk) => apiData(postApiV1AdminProductsBulkUpdate({ body: { products: claims(chunk), categoryId: id } })));
      return;
    }
    let expectedVersion = manualCollections.find((collection) => collection.id === id)?.version ?? 1;
    await inChunks(rows, async (chunk) => {
      const ids = chunk.map((row) => row.id);
      const result = await apiData(postApiV1AdminCollectionsByIdProducts({
        path: { id },
        body: { expectedVersion, ...(kind === "addToCollection" ? { add: ids } : { remove: ids }) },
      }));
      expectedVersion = result.version;
    });
  }, INVALIDATE);

  const open = (next: Picker) => {
    setChoice("");
    setPicker(next);
  };
  const busy = setStatus.isPending || change.isPending;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => setStatus.mutate({ variables: true }, { onSuccess: done })}
      >
        {t("setActive")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => (liveCount > 0 ? setConfirmDraft(true) : setStatus.mutate({ variables: false }, { onSuccess: done }))}
      >
        {t("setDraft")}
      </Button>
      <ConfirmDialog
        open={confirmDraft}
        onOpenChange={setConfirmDraft}
        title={t("draftConfirmTitle", { count })}
        description={t("draftConfirmBody", { count: liveCount })}
        confirmLabel={t("setDraft")}
        // Reversible (Set as active undoes it): a primary button, not a destructive one.
        variant="default"
        cancelLabel={r("cancel")}
        loadingLabel={r("working")}
        isLoading={setStatus.isPending}
        onConfirm={() => setStatus.mutate({ variables: false }, {
          onSuccess: done,
          onSettled: () => setConfirmDraft(false),
        })}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={busy}>
            {r("moreActions")}
            <ChevronDown className="ml-1 h-4 w-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => open("addToCollection")}>{t("addToCollection")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => open("removeFromCollection")}>{t("removeFromCollection")}</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => open("category")}>{t("changeCategory")}</DropdownMenuItem>
          <DropdownMenuItem disabled={printLabels.isPending} onSelect={() => printLabels.mutate()}>{t("printLabels")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={picker !== null} onOpenChange={(next) => { if (!next && !change.isPending) setPicker(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {picker === "category"
                ? t("changeCategoryTitle", { count })
                : picker === "removeFromCollection"
                  ? t("removeFromCollectionTitle", { count })
                  : t("addToCollectionTitle", { count })}
            </DialogTitle>
            <DialogDescription>
              {picker === "category" ? t("changeCategoryHelp") : t("manualCollectionsHelp")}
            </DialogDescription>
          </DialogHeader>
          <SearchableSelect
            value={choice}
            onValueChange={setChoice}
            options={options}
            placeholder={picker === "category" ? t("chooseCategory") : t("chooseCollection")}
            searchPlaceholder={picker === "category" ? t("searchCategories") : t("searchCollections")}
            emptyMessage={picker === "category" ? r("noResults") : t("noManualCollections")}
            ariaLabel={picker === "category" ? t("category") : t("collection")}
            triggerClassName="w-full"
          />
          <DialogFooter>
            <Button variant="outline" disabled={change.isPending} onClick={() => setPicker(null)}>
              {r("cancel")}
            </Button>
            <Button
              disabled={!choice}
              loading={change.isPending}
              onClick={() => picker && change.mutate(
                {
                  variables: { kind: picker, id: choice },
                  success: picker === "category"
                    ? t("categoryChanged")
                    : picker === "addToCollection" ? t("addedToCollection") : t("removedFromCollection"),
                },
                {
                  onSuccess: () => {
                    setPicker(null);
                    done();
                  },
                },
              )}
            >
              {t("apply")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
