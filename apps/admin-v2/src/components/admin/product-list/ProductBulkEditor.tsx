import { Fragment, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  getApiV1AdminProductsBulkEdit,
  patchApiV1AdminProductsByIdSectionsBySection,
  postApiV1AdminInventoryStockSet,
} from "@scalius/api-client/sdk";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Card } from "~/components/ui/card";
import { NumberInput } from "~/components/ui/number-input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { MoneyInput } from "~/components/admin/shared/MoneyInput";
import { Page } from "~/components/admin/resource/Page";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { ErrorState } from "~/components/admin/states";
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
  /** SKU id -> on hand. */
  stock: Record<string, number | null>;
}

const draftOf = (product: BulkProduct, salePrice: (price: number, discount: object) => number | null): ProductDraft => {
  const discounted = product.discountType === "flat" ? product.discountAmount > 0 : product.discountPercentage > 0;
  return {
    isActive: product.isActive,
    pair: pairFromStored(product.price, discounted ? salePrice(product.price, product) : null),
    stock: Object.fromEntries(product.skus.map((sku) => [sku.id, sku.onHand])),
  };
};

const samePair = (a: PricePair, b: PricePair) => a.price === b.price && a.compareAt === b.compareAt;

/**
 * Bulk editor (Shopify's "Bulk edit"): the selected products in one grid,
 * status, price and compare-at price of a product without options, and the
 * on-hand quantity of every SKU at the default location. Save sends only the
 * changed cells through the same guarded writes the product page uses (the
 * base section with its revision, a stocktake with its own key) and reports
 * any row that could not be saved; the rest stay saved.
 */
export function ProductBulkEditor({ ids }: { ids: string[] }) {
  const t = useMessages(productBulkEditMessages);
  return (
    <SaveBarProvider savedMessage={t("bulkEditSaved")}>
      <BulkEditorGrid ids={ids} />
    </SaveBarProvider>
  );
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
    return next.isActive !== was.isActive || !samePair(next.pair, was.pair)
      || product.skus.some((sku) => next.stock[sku.id] !== was.stock[sku.id]);
  });
  const priceProblem = (product: BulkProduct) => {
    const pair = draft(product.id).pair;
    if (product.hasOptions || samePair(pair, base[product.id]!.pair)) return null;
    if (pair.price === null || !Number.isFinite(pair.price) || pair.price < 0) return t("bulkEditPriceRequired");
    return storedFromPair(pair, decimalPlaces).problem ? t("bulkEditCompareAtHigher") : null;
  };
  const invalid = changed.some((product) => priceProblem(product) !== null
    || product.skus.some((sku) => { const value = draft(product.id).stock[sku.id]; return value === null || value === undefined || value < 0; }));

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
        if (Object.keys(patch).length > 0) {
          await apiData(patchApiV1AdminProductsByIdSectionsBySection({
            path: { id: product.id, section: "base" },
            body: { section: "base", expectedAggregateRevision: product.aggregateRevision, patch } as never,
          }));
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

  return (
    <Page width="index">
      <PageHeader backTo="/admin/products" title={t("bulkEditTitle")} meta={t("bulkEditMeta", { count: ids.length })} />
      {query.isError ? (
        <ErrorState onRetry={() => void query.refetch()} />
      ) : (
        <Card className="overflow-clip p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("bulkEditProduct")}</TableHead>
                <TableHead>{t("bulkEditStatus")}</TableHead>
                <TableHead data-numeric>{t("bulkEditPrice")}</TableHead>
                <TableHead data-numeric>{t("bulkEditCompareAt")}</TableHead>
                <TableHead data-numeric>{t("bulkEditOnHand")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loaded.map((product) => {
                const next = draft(product.id);
                const problem = priceProblem(product);
                const single = !product.hasOptions ? product.skus[0] : undefined;
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
