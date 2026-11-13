import { Fragment, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { getApiV1AdminProductsBulkEdit, postApiV1AdminProductsBulkEdit } from "@scalius/api-client/sdk";
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
import { WeightInput, useWeightUnit } from "~/components/admin/product-form/variants/WeightInput";
import { formatWeight } from "~/components/admin/product-form/variants/weight-format";
import { shippingProfilesQuery } from "~/lib/api-query-options/shipping-profiles";
import { seededName } from "~/lib/seeded-names";
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
import { productListMessages } from "~/i18n/product-list";
import { realtimeMergeMessages } from "~/i18n/realtime-merge";

type BulkProduct = ApiResult<typeof getApiV1AdminProductsBulkEdit>["products"][number];
type BulkSaveRow = NonNullable<Parameters<typeof postApiV1AdminProductsBulkEdit>[0]>["body"]["products"][number];

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
 * The cells the merchant touched on one product, and nothing else: every other
 * cell shows the latest read, so a refetch (a realtime catch-up, a save) never
 * turns a colleague's change or a sale into an edit of this one. The edits
 * keep the revision and the values they were made against (`revision`,
 * `from`): a refetch moves the read, never the version the save asserts, so a
 * colleague's save in between is refused by the server, never overwritten. A
 * count keeps the stock version it was typed against.
 */
interface ProductTouches {
  /** The product's aggregateRevision when the first cell was touched: the save asserts it. */
  revision: number;
  /** The row as it read then: what "theirs" is compared with when the revision moves. */
  from: ProductDraft;
  isActive?: boolean;
  pair?: PricePair;
  profileId?: string | null;
  stock?: Record<string, { value: number | null; stockVersion: number }>;
  weight?: Record<string, number | null>;
}

/** The latest read with the touched cells on top. */
const viewOf = (read: ProductDraft, touches: ProductTouches | undefined): ProductDraft => !touches ? read : {
  isActive: touches.isActive ?? read.isActive,
  pair: touches.pair ?? read.pair,
  profileId: touches.profileId !== undefined ? touches.profileId : read.profileId,
  stock: { ...read.stock, ...Object.fromEntries(Object.entries(touches.stock ?? {}).map(([id, count]) => [id, count.value])) },
  weight: { ...read.weight, ...touches.weight },
};

/**
 * Bulk editor (Shopify's "Bulk edit"): the selected products in one grid,
 * status, price and compare-at price of a product without options, its
 * shipping profile, the weight of every shipped SKU, and the on-hand quantity
 * of every SKU at the default location. Save sends only the changed cells,
 * every row in one request (dashboard.products.bulk_edit_save: each product
 * commits alone under its revision, counts go through the stock ledger under
 * the request's key); a plan that commits fewer rows per request hands the
 * rest back and they go next. A row that could not be saved keeps its
 * changes and says why; the rest stay saved.
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
  const product = useMessages(productListMessages);
  const merge = useMessages(realtimeMergeMessages);
  const { code, salePrice, fmt } = useCurrency();
  const weightUnit = useWeightUnit();
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
      ? product("shippingProfileDefault", { name: seededName(profile) })
      : profile.freeDelivery ? product("shippingProfileFree", { name: seededName(profile) }) : seededName(profile),
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
  const [edits, setEdits] = useState<Record<string, ProductTouches>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  // A save the plan splits over requests: how far it got (each row is sent until it has an answer, never again after).
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // One retry key per exact request body: a repeat of a save whose answer was lost replays it.
  const retryKeys = useRef(new Map<string, string>());
  const draft = (id: string) => viewOf(base[id]!, edits[id]);
  // The first touch of a row pins the revision and values the edits are made against.
  const pinned = (current: Record<string, ProductTouches>, product: BulkProduct): ProductTouches =>
    current[product.id] ?? { revision: product.aggregateRevision, from: base[product.id]! };
  const touch = (product: BulkProduct, patch: Pick<ProductTouches, "isActive" | "pair" | "profileId">) =>
    setEdits((current) => ({ ...current, [product.id]: { ...pinned(current, product), ...patch } }));
  const touchWeight = (product: BulkProduct, skuId: string, grams: number | null) =>
    setEdits((current) => {
      const row = pinned(current, product);
      return { ...current, [product.id]: { ...row, weight: { ...row.weight, [skuId]: grams } } };
    });
  const touchStock = (product: BulkProduct, skuId: string, value: number | null) =>
    setEdits((current) => {
      const row = pinned(current, product);
      const counts = row.stock ?? {};
      // The version the count was typed against: the read the merchant saw when they first typed it.
      const stockVersion = counts[skuId]?.stockVersion ?? product.skus.find((sku) => sku.id === skuId)!.stockVersion;
      return { ...current, [product.id]: { ...row, stock: { ...counts, [skuId]: { value, stockVersion } } } };
    });
  /** Someone saved the product since its edits began: the save is refused until the merchant chooses. */
  const movedUnder = (product: BulkProduct) => edits[product.id] !== undefined && edits[product.id]!.revision !== product.aggregateRevision
    && changedIds.has(product.id);
  /** Keep mine: the edits now sit on the latest revision, and the next save applies them over it. */
  const keepMine = (product: BulkProduct) => {
    setEdits((current) => current[product.id]
      ? { ...current, [product.id]: { ...current[product.id]!, revision: product.aggregateRevision, from: base[product.id]! } }
      : current);
    setFailures(({ [product.id]: _, ...rest }) => rest);
  };
  /** Take theirs: the row's edits are dropped and it shows the latest save. */
  const takeTheirs = (product: BulkProduct) => {
    setEdits(({ [product.id]: _, ...rest }) => rest);
    setFailures(({ [product.id]: _, ...rest }) => rest);
  };

  /** The other save's value of each cell the merchant touched that it changed too. */
  const theirValues = (row: BulkProduct): string[] => {
    const touches = edits[row.id];
    const latest = base[row.id];
    if (!touches || !latest) return [];
    const line = (field: string, value: string) => t("bulkEditTheirValue", { field, value });
    const money = (value: number | null) => (value === null ? merge("emptyValue") : fmt(value));
    const lines: string[] = [];
    if (touches.isActive !== undefined && latest.isActive !== touches.from.isActive) {
      lines.push(line(t("bulkEditStatus"), latest.isActive ? product("statusActive") : product("statusDraft")));
    }
    if (touches.pair && latest.pair.price !== touches.from.pair.price) lines.push(line(t("bulkEditPrice"), money(latest.pair.price)));
    if (touches.pair && latest.pair.compareAt !== touches.from.pair.compareAt) lines.push(line(t("bulkEditCompareAt"), money(latest.pair.compareAt)));
    if (touches.profileId !== undefined && latest.profileId !== touches.from.profileId) {
      lines.push(line(t("bulkEditShippingProfile"), profileOptions.find((option) => option.value === (latest.profileId ?? DEFAULT_PROFILE))?.label ?? merge("emptyValue")));
    }
    for (const skuId of Object.keys(touches.weight ?? {})) {
      const grams = latest.weight[skuId];
      if (grams !== touches.from.weight[skuId]) lines.push(line(t("bulkEditWeight"), grams === null || grams === undefined ? merge("emptyValue") : formatWeight(grams, weightUnit)));
    }
    return lines;
  };

  const changed = loaded.filter((product) => Object.keys(rowOf(product)).some((key) => key === "base" || key === "skus"));
  const changedIds = new Set(changed.map((product) => product.id));
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

  /** A product as the save takes it: only the touched cells that differ from the latest read. */
  function rowOf(product: BulkProduct): BulkSaveRow {
    const was = base[product.id]!;
    const touches: Partial<ProductTouches> = edits[product.id] ?? {};
    const patch: NonNullable<BulkSaveRow["base"]> = {};
    if (touches.isActive !== undefined && touches.isActive !== was.isActive) patch.isActive = touches.isActive;
    if (!product.hasOptions && touches.pair && !samePair(touches.pair, was.pair)) {
      const stored = storedFromPair(touches.pair, decimalPlaces);
      // A missing price never gets here: the save bar stays invalid until it is entered.
      if (stored.price !== null) patch.price = stored.price;
      patch.discountType = "flat";
      patch.discountAmount = stored.discounted ? stored.discountAmount : 0;
      patch.discountPercentage = 0;
    }
    if (touches.profileId !== undefined && touches.profileId !== was.profileId) patch.shippingProfileId = touches.profileId;
    const skus = product.skus.flatMap((sku) => {
      const change: NonNullable<BulkSaveRow["skus"]>[number] = { id: sku.id };
      const grams = touches.weight?.[sku.id];
      if (sku.ships && touches.weight && sku.id in touches.weight && grams !== was.weight[sku.id]) change.weightGrams = grams === null || grams === undefined ? null : Math.round(grams);
      const count = touches.stock?.[sku.id];
      // Sent with the version it was counted against: a sale since refuses it, never books it back.
      if (sku.trackInventory && count && count.value !== null && (count.value !== was.stock[sku.id] || count.stockVersion !== sku.stockVersion)) {
        change.onHand = count.value;
        change.expectedStockVersion = count.stockVersion;
      }
      return Object.keys(change).length > 1 ? [change] : [];
    });
    return {
      id: product.id,
      // The revision the edits were made against, never one a refetch read since.
      expectedAggregateRevision: touches.revision ?? product.aggregateRevision,
      ...(Object.keys(patch).length > 0 ? { base: patch } : {}),
      ...(skus.length > 0 ? { skus } : {}),
    };
  }

  const save = async () => {
    const problems: Record<string, string> = {};
    const saved = new Set<string>();
    // Counts refused because the stock moved: shown again from the latest read, to count again.
    const recount: Array<[string, string]> = [];
    // One request for every row; rows the plan could not take in one come back as `remaining` and go next.
    let pending = changed.map(rowOf);
    const total = pending.length;
    let first = true;
    while (pending.length > 0) {
      if (!first) setProgress({ done: total - pending.length, total });
      first = false;
      let outcome: ApiResult<typeof postApiV1AdminProductsBulkEdit>;
      try {
        const body = { products: pending };
        const text = JSON.stringify(body);
        const key = retryKeys.current.get(text) ?? crypto.randomUUID();
        retryKeys.current.set(text, key);
        outcome = await apiData(postApiV1AdminProductsBulkEdit({
          body,
          // The same body again (its answer was lost) replays the first answer; nothing is booked twice.
          headers: { "idempotency-key": key },
        }));
      } catch (error) {
        const message = getServerFnError(error, t("bulkEditRowFailed"));
        for (const row of pending) problems[row.id] = message;
        break;
      }
      for (const result of outcome.results) {
        if (result.status === "saved") {
          saved.add(result.id);
          continue;
        }
        if (result.code === "stock_changed") {
          const skuId = /^skus\.(.+)\.onHand$/.exec(result.field ?? "")?.[1];
          if (skuId) recount.push([result.id, skuId]);
        }
        problems[result.id] = result.code === "product_revision_conflict" ? t("bulkEditRowChanged")
          : result.code === "stock_changed" ? t("bulkEditStockChanged")
            : result.message || t("bulkEditRowFailed");
      }
      const remaining = new Set(outcome.remaining);
      const next = pending.filter((row) => remaining.has(row.id));
      // A request that took nothing would loop: say so on the rows instead.
      if (next.length === pending.length) {
        for (const row of next) problems[row.id] = t("bulkEditRowFailed");
        break;
      }
      pending = next;
    }
    setProgress(null);
    setEdits((current) => {
      const next = Object.fromEntries(Object.entries(current).filter(([id]) => !saved.has(id)));
      for (const [id, skuId] of recount) {
        const { [skuId]: _, ...counts } = next[id]?.stock ?? {};
        if (next[id]) next[id] = { ...next[id], stock: counts };
      }
      return next;
    });
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
          {progress ? <p className="px-4 pt-3 text-body text-muted-foreground" role="status">{t("bulkEditSaving", progress)}</p> : null}
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
                    onGramsChange={(grams) => touchWeight(product, sku.id, grams)}
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
                        onValueChange={(value) => touchStock(product, sku.id, value)}
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
                        {movedUnder(product) ? (
                          <div role="alert" className="mt-1 space-y-1">
                            <p className="text-body text-destructive">{t("bulkEditChangedElsewhere")}</p>
                            {(() => {
                              const theirs = theirValues(product);
                              return theirs.length > 0
                                ? <ul className="text-body text-muted-foreground">{theirs.map((value) => <li key={value}>{value}</li>)}</ul>
                                : <p className="text-body text-muted-foreground">{t("bulkEditTheirOther")}</p>;
                            })()}
                            <div className="flex flex-wrap gap-2">
                              <Button type="button" size="sm" variant="outline" onClick={() => keepMine(product)}>{merge("keepYours")}</Button>
                              <Button type="button" size="sm" variant="outline" onClick={() => takeTheirs(product)}>{merge("keepTheirs")}</Button>
                            </div>
                          </div>
                        ) : failures[product.id] ? <p role="alert" className="text-body text-destructive">{failures[product.id]}</p> : null}
                      </TableCell>
                      <TableCell className="w-36">
                        <SearchableSelect
                          triggerClassName="w-32"
                          ariaLabel={t("bulkEditStatusFor", { name: product.name })}
                          disabled={!canEdit}
                          value={next.isActive ? "active" : "draft"}
                          onValueChange={(value) => touch(product, { isActive: value === "active" })}
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
                              onValueChange={(price) => touch(product, { pair: { ...next.pair, price } })}
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
                              onValueChange={(compareAt) => touch(product, { pair: { ...next.pair, compareAt } })}
                            />
                          </TableCell>
                        </>
                      )}
                      <TableCell className="w-32">{product.hasOptions ? null : stockCell(single, product.name)}</TableCell>
                      <TableCell className="w-44">
                        {ships && profileOptions.length > 1 ? (
                          <SearchableSelect
                            triggerClassName="w-40"
                            ariaLabel={t("bulkEditShippingProfileFor", { name: product.name })}
                            disabled={!canEdit}
                            value={next.profileId ?? DEFAULT_PROFILE}
                            onValueChange={(value) => touch(product, { profileId: value === DEFAULT_PROFILE ? null : value })}
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
