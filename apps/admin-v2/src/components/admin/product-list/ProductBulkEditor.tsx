import { Fragment, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  getApiV1AdminProductsBulkEdit,
  patchApiV1AdminProductsByIdSectionsBySection,
  patchApiV1AdminResourcesProductsByIdVariantsByVariantId,
  postApiV1AdminInventoryStockSet,
} from "@scalius/api-client/sdk";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { PackageSearch } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { useShownAfter } from "~/components/admin/states/loading-sign";
import { NumberInput } from "~/components/ui/number-input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { MoneyInput } from "~/components/admin/shared/MoneyInput";
import { WeightInput } from "~/components/admin/product-form/variants/WeightInput";
import { shippingProfilesQuery } from "~/lib/api-query-options/shipping-profiles";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { Page } from "~/components/admin/resource/Page";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { EmptyState, ErrorState } from "~/components/admin/states";
import { SaveBarProvider, SaveNotCompleted, useSaveBar } from "~/components/admin/shared/SaveBar";
import { pairFromStored, storedFromPair, type PricePair } from "~/components/admin/product-form/compare-at";
import { usePermissions } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { apiData, type ApiResult } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { productBulkEditMessages } from "~/i18n/product-bulk-edit";
import { productMessages } from "~/i18n/products";

type BulkProduct = ApiResult<typeof getApiV1AdminProductsBulkEdit>["products"][number];

interface ProductDraft {
  isActive: boolean;
  pair: PricePair;
  /** Null: the default profile (General). */
  profileId: string | null;
  /** SKU id -> on hand. */
  stock: Record<string, number | null>;
  /** Shipped SKU id -> grams (null: no weight). */
  weight: Record<string, number | null>;
}

const DEFAULT_PROFILE = "shp_default";

const draftOf = (product: BulkProduct, salePrice: (price: number, discount: object) => number | null): ProductDraft => {
  const discounted = product.discountType === "flat" ? product.discountAmount > 0 : product.discountPercentage > 0;
  return {
    isActive: product.isActive,
    pair: pairFromStored(product.price, discounted ? salePrice(product.price, product) : null),
    profileId: product.shippingProfileId,
    stock: Object.fromEntries(product.skus.map((sku) => [sku.id, sku.onHand])),
    weight: Object.fromEntries(product.skus.filter((sku) => sku.ships).map((sku) => [sku.id, sku.weightGrams])),
  };
};

const samePair = (a: PricePair, b: PricePair) => a.price === b.price && a.compareAt === b.compareAt;

/**
 * Bulk editor (Shopify's "Bulk edit"): the selected products in one grid,
 * status, price and compare-at price of a product without options, its
 * shipping profile, the weight of every shipped SKU, and the on-hand quantity
 * of every SKU at the default location. Save sends only the changed cells
 * through the same guarded writes the product page uses (the base section
 * and the SKU patch under the product's revision, a stocktake with its own
 * key) and reports any row that could not be saved; the rest stay saved.
 */
export function ProductBulkEditor({ ids }: { ids: string[] }) {
  const t = useMessages(productBulkEditMessages);
  // Opened without a selection (a bookmark, a typed address): say how to get one.
  if (ids.length === 0) {
    return (
      <Page width="index">
        <PageHeader backTo="/admin/products" title={t("bulkEditTitle")} />
        <EmptyState
          icon={PackageSearch}
          title={t("bulkEditNoSelectionTitle")}
          description={t("bulkEditNoSelectionBody")}
          action={<Button asChild><Link to="/admin/products">{t("bulkEditChooseProducts")}</Link></Button>}
          help={false}
        />
      </Page>
    );
  }
  return (
    <SaveBarProvider savedMessage={t("bulkEditSaved")}>
      <BulkEditorGrid ids={ids} />
    </SaveBarProvider>
  );
}

/** The grid's shape while the selection loads (L2/L3): its real headings, a row per product. */
function BulkEditorSkeleton({ rows }: { rows: number }) {
  return Array.from({ length: Math.min(rows, 50) }, (_, index) => (
    <TableRow key={index} still aria-hidden="true" data-slot="skeleton">
      <TableCell className="min-w-56"><Skeleton className="h-3.5 w-48 max-w-full" /></TableCell>
      <TableCell className="w-36"><Skeleton className="h-9 w-32" /></TableCell>
      <TableCell className="w-40"><Skeleton className="ms-auto h-9 w-36" /></TableCell>
      <TableCell className="w-40"><Skeleton className="ms-auto h-9 w-36" /></TableCell>
      <TableCell className="w-32"><Skeleton className="ms-auto h-9 w-28" /></TableCell>
      <TableCell className="w-44"><Skeleton className="h-9 w-40" /></TableCell>
      <TableCell className="w-32"><Skeleton className="ms-auto h-9 w-28" /></TableCell>
    </TableRow>
  ));
}

function BulkEditorGrid({ ids }: { ids: string[] }) {
  const t = useMessages(productBulkEditMessages);
  const product = useMessages(productMessages);
  const { code, salePrice } = useCurrency();
  const decimalPlaces = getDecimalPlaces(code);
  const queryClient = useQueryClient();
  const { hasPermission } = usePermissions();
  const canEdit = hasPermission(PERMISSIONS.PRODUCTS_EDIT);
  const canStock = hasPermission(PERMISSIONS.PRODUCTS_ADJUST_STOCK);
  // The choices need the profiles list; without it the column shows nothing to pick.
  const profiles = useQuery({ ...shippingProfilesQuery, enabled: hasPermission(ADMIN_PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW) }).data ?? [];
  const profileOptions = profiles.map((profile) => ({
    value: profile.id,
    label: profile.isDefault
      ? product("shippingProfileDefault", { name: profile.name })
      : profile.freeDelivery ? product("shippingProfileFree", { name: profile.name }) : profile.name,
  }));
  const query = useQuery({
    queryKey: [...queryKeys.products.all, "bulk-edit", ids.join(",")],
    queryFn: () => apiData(getApiV1AdminProductsBulkEdit({ query: { ids: ids.join(",") } })),
    enabled: ids.length > 0,
    staleTime: 0,
  });
  const loaded = useMemo(() => query.data?.products ?? [], [query.data]);
  const base = useMemo(
    () => Object.fromEntries(loaded.map((product) => [product.id, draftOf(product, (price, discount) => salePrice(price, discount))])),
    [loaded, salePrice],
  );
  const [edits, setEdits] = useState<Record<string, ProductDraft>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const draft = (id: string) => edits[id] ?? base[id]!;
  const change = (id: string, patch: Partial<ProductDraft>) =>
    setEdits((current) => ({ ...current, [id]: { ...(current[id] ?? base[id]!), ...patch } }));

  const changed = loaded.filter((product) => {
    const next = edits[product.id];
    if (!next) return false;
    const was = base[product.id]!;
    return next.isActive !== was.isActive || !samePair(next.pair, was.pair) || next.profileId !== was.profileId
      || product.skus.some((sku) => next.stock[sku.id] !== was.stock[sku.id] || next.weight[sku.id] !== was.weight[sku.id]);
  });
  const priceProblem = (product: BulkProduct) => {
    const pair = draft(product.id).pair;
    if (product.hasOptions || samePair(pair, base[product.id]!.pair)) return null;
    if (pair.price === null || !Number.isFinite(pair.price) || pair.price < 0) return t("bulkEditPriceRequired");
    return storedFromPair(pair, decimalPlaces).problem ? t("bulkEditCompareAtHigher") : null;
  };
  const weightInvalid = (grams: number | null | undefined) => grams !== null && grams !== undefined && (!Number.isFinite(grams) || grams < 0 || grams > 1_000_000);
  const invalid = changed.some((product) => priceProblem(product) !== null
    || product.skus.some((sku) => { const value = draft(product.id).stock[sku.id]; return sku.trackInventory && (value === null || value === undefined || value < 0); })
    || product.skus.some((sku) => weightInvalid(draft(product.id).weight[sku.id])));

  const save = async () => {
    const problems: Record<string, string> = {};
    for (const product of changed) {
      const was = base[product.id]!;
      const next = draft(product.id);
      try {
        const patch: Record<string, unknown> = {};
        if (next.isActive !== was.isActive) patch.isActive = next.isActive;
        if (!product.hasOptions && !samePair(next.pair, was.pair)) {
          const stored = storedFromPair(next.pair, decimalPlaces);
          patch.price = stored.price;
          patch.discountType = "flat";
          patch.discountAmount = stored.discounted ? stored.discountAmount : 0;
          patch.discountPercentage = 0;
        }
        if (next.profileId !== was.profileId) patch.shippingProfileId = next.profileId;
        let revision = product.aggregateRevision;
        if (Object.keys(patch).length > 0) {
          revision = (await apiData(patchApiV1AdminProductsByIdSectionsBySection({
            path: { id: product.id, section: "base" },
            body: { section: "base", expectedAggregateRevision: revision, patch } as never,
          })) as { aggregateRevision: number }).aggregateRevision;
        }
        // Each weight under the revision the last write left.
        for (const sku of product.skus) {
          if (!sku.ships || next.weight[sku.id] === was.weight[sku.id]) continue;
          const grams = next.weight[sku.id];
          revision = (await apiData(patchApiV1AdminResourcesProductsByIdVariantsByVariantId({
            path: { id: product.id, variantId: sku.id },
            body: { expectedRevision: revision, weightGrams: grams === null || grams === undefined ? null : Math.round(grams) },
          }))).product.revision;
        }
        for (const sku of product.skus) {
          const newStock = next.stock[sku.id];
          if (!sku.trackInventory || newStock === was.stock[sku.id] || newStock === null || newStock === undefined) continue;
          await apiData(postApiV1AdminInventoryStockSet({
            body: { variantId: sku.id, newStock, reason: "Bulk edit" },
            headers: { "idempotency-key": crypto.randomUUID() },
          }));
        }
        setEdits((current) => { const { [product.id]: _, ...rest } = current; return rest; });
      } catch (error) {
        problems[product.id] = getServerFnError(error, t("bulkEditRowFailed"));
      }
    }
    setFailures(problems);
    await queryClient.invalidateQueries({ queryKey: queryKeys.products.all });
    const failed = Object.keys(problems).length;
    if (failed > 0) throw new SaveNotCompleted(t("bulkEditSomeFailed", { count: failed }));
  };

  useSaveBar({
    label: t("bulkEditTitle"),
    dirty: changed.length > 0,
    invalid,
    save,
    discard: () => { setEdits({}); setFailures({}); },
  });

  const statusOptions = [
    { value: "active", label: product("statusActive") },
    { value: "draft", label: product("statusDraft") },
  ];

  const pending = query.isPending;
  const skeletonShown = useShownAfter(pending);
  // Products deleted (or put in trash) since they were chosen are not in the read.
  const missing = pending ? 0 : Math.max(0, ids.length - loaded.length);

  return (
    <Page width="index">
      <PageHeader backTo="/admin/products" title={t("bulkEditTitle")} meta={t("bulkEditMeta", { count: pending ? ids.length : loaded.length })} />
      {query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} />
      ) : !pending && loaded.length === 0 ? (
        <EmptyState
          icon={PackageSearch}
          title={t("bulkEditGoneTitle")}
          description={t("bulkEditGoneBody")}
          action={<Button asChild><Link to="/admin/products">{t("bulkEditChooseProducts")}</Link></Button>}
          help={false}
        />
      ) : (
        <Card className="overflow-clip p-0" aria-busy={pending || undefined}>
          <span className="sr-only" role="status" aria-live="polite">{pending && skeletonShown ? t("bulkEditLoading") : ""}</span>
          {missing > 0 ? (
            <Alert className="m-4"><AlertDescription>{t("bulkEditSomeGone", { count: missing })}</AlertDescription></Alert>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("bulkEditProduct")}</TableHead>
                <TableHead>{t("bulkEditStatus")}</TableHead>
                <TableHead data-numeric>{t("bulkEditPrice")}</TableHead>
                <TableHead data-numeric>{t("bulkEditCompareAt")}</TableHead>
                <TableHead data-numeric>{t("bulkEditOnHand")}</TableHead>
                <TableHead>{t("bulkEditShippingProfile")}</TableHead>
                <TableHead data-numeric>{t("bulkEditWeight")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className={cn(pending && !skeletonShown && "invisible")}>
              {pending ? <BulkEditorSkeleton rows={ids.length} /> : null}
              {loaded.map((product) => {
                const next = draft(product.id);
                const problem = priceProblem(product);
                const single = !product.hasOptions ? product.skus[0] : undefined;
                const weightCell = (sku: BulkProduct["skus"][number] | undefined, label: string) => !sku || !sku.ships ? null : (
                  <WeightInput
                    className="ms-auto w-28 text-end"
                    aria-label={t("bulkEditWeightFor", { name: label })}
                    disabled={!canEdit}
                    grams={next.weight[sku.id] ?? null}
                    aria-invalid={weightInvalid(next.weight[sku.id]) || undefined}
                    onGramsChange={(grams) => change(product.id, { weight: { ...next.weight, [sku.id]: grams } })}
                  />
                );
                const ships = product.skus.some((sku) => sku.ships);
                const stockCell = (sku: BulkProduct["skus"][number] | undefined, label: string) => !sku ? <span className="text-muted-foreground">—</span>
                  : !sku.trackInventory ? <span className="text-muted-foreground">{t("bulkEditNotTracked")}</span>
                    : (
                      <NumberInput
                        integer
                        className="ms-auto w-28 text-end"
                        aria-label={t("bulkEditOnHandFor", { name: label })}
                        disabled={!canStock}
                        value={next.stock[sku.id] ?? null}
                        aria-invalid={(next.stock[sku.id] ?? -1) < 0 || undefined}
                        onValueChange={(value) => change(product.id, { stock: { ...next.stock, [sku.id]: value } })}
                      />
                    );
                return (
                  <Fragment key={product.id}>
                    <TableRow>
                      <TableCell className="min-w-56">
                        <Link to="/admin/products/$productId/edit" params={{ productId: product.id }} className="text-body font-medium text-link hover:underline">
                          {product.name}
                        </Link>
                        {single ? <p className="font-mono text-body text-muted-foreground">{single.sku}</p> : null}
                        {failures[product.id] ? <p role="alert" className="text-body text-destructive">{failures[product.id]}</p> : null}
                      </TableCell>
                      <TableCell className="w-36">
                        <SearchableSelect
                          triggerClassName="w-32"
                          aria-label={t("bulkEditStatusFor", { name: product.name })}
                          disabled={!canEdit}
                          value={next.isActive ? "active" : "draft"}
                          onValueChange={(value) => change(product.id, { isActive: value === "active" })}
                          options={statusOptions}
                        />
                      </TableCell>
                      {product.hasOptions ? (
                        <TableCell colSpan={2} className="text-end"><span className="text-muted-foreground">{t("bulkEditPricesPerVariant")}</span></TableCell>
                      ) : (
                        <>
                          <TableCell className="w-40">
                            <MoneyInput
                              currencyCode={code}
                              className="ms-auto w-36"
                              aria-label={t("bulkEditPriceFor", { name: product.name })}
                              aria-invalid={problem ? true : undefined}
                              disabled={!canEdit}
                              value={next.pair.price}
                              onValueChange={(price) => change(product.id, { pair: { ...next.pair, price } })}
                            />
                            {problem ? <p className="text-end text-body text-destructive">{problem}</p> : null}
                          </TableCell>
                          <TableCell className="w-40">
                            <MoneyInput
                              currencyCode={code}
                              className="ms-auto w-36"
                              aria-label={t("bulkEditCompareAtFor", { name: product.name })}
                              disabled={!canEdit}
                              value={next.pair.compareAt}
                              onValueChange={(compareAt) => change(product.id, { pair: { ...next.pair, compareAt } })}
                            />
                          </TableCell>
                        </>
                      )}
                      <TableCell className="w-32">{product.hasOptions ? null : stockCell(single, product.name)}</TableCell>
                      <TableCell className="w-44">
                        {ships && profileOptions.length > 1 ? (
                          <SearchableSelect
                            triggerClassName="w-40"
                            aria-label={t("bulkEditShippingProfileFor", { name: product.name })}
                            disabled={!canEdit}
                            value={next.profileId ?? DEFAULT_PROFILE}
                            onValueChange={(value) => change(product.id, { profileId: value === DEFAULT_PROFILE ? null : value })}
                            options={profileOptions}
                          />
                        ) : null}
                      </TableCell>
                      <TableCell className="w-32">{product.hasOptions ? null : weightCell(single, product.name)}</TableCell>
                    </TableRow>
                    {product.hasOptions ? product.skus.map((sku) => (
                      <TableRow key={sku.id}>
                        <TableCell className="ps-8">
                          <p className="text-body">{sku.label}</p>
                          <p className="font-mono text-body text-muted-foreground">{sku.sku}</p>
                        </TableCell>
                        <TableCell />
                        <TableCell />
                        <TableCell />
                        <TableCell className="w-32">{stockCell(sku, `${product.name} ${sku.label ?? ""}`)}</TableCell>
                        <TableCell />
                        <TableCell className="w-32">{weightCell(sku, `${product.name} ${sku.label ?? ""}`)}</TableCell>
                      </TableRow>
                    )) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
          {!canStock ? (
            <Alert className="m-4"><AlertDescription>{t("bulkEditNoStockPermission")}</AlertDescription></Alert>
          ) : null}
        </Card>
      )}
    </Page>
  );
}
