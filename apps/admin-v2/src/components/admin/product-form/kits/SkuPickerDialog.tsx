import { useMemo, useState } from "react";
import { infiniteQueryOptions, useInfiniteQuery } from "@tanstack/react-query";
import { ImageIcon, Loader2 } from "lucide-react";
import { getApiV1AdminProductsSkuOptions } from "@scalius/api-client/sdk";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { apiData, type ApiResult } from "~/lib/api";
import { useCurrency } from "~/hooks/use-currency";
import { useDebounce } from "~/hooks/use-debounce";
import { availableStockText } from "~/lib/stock-availability";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { useMessages } from "~/i18n";
import { productKitMessages, type ProductKitMessageKey } from "~/i18n/product-kits";
import { resourceMessages } from "~/i18n/resource";

export type SkuOption = ApiResult<typeof getApiV1AdminProductsSkuOptions>["items"][number];

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 300;

export const skuOptionsQueryOptions = (search: string) =>
  infiniteQueryOptions({
    queryKey: ["products", "sku-options", search] as const,
    queryFn: ({ pageParam }) => apiData(getApiV1AdminProductsSkuOptions({ query: { search: search || undefined, page: pageParam, limit: PAGE_SIZE } })),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
    staleTime: 30_000,
  });

/** "Size: M · Colour: Red", a SKU's options on one line. */
export function optionLine(options: ReadonlyArray<{ name: string; value: string }>): string {
  return options.map((option) => `${option.name}: ${option.value}`).join(" · ");
}

/** A SKU's name as the editor writes it: its product, then its option values. */
export function skuName(sku: { productName: string | null; options: ReadonlyArray<{ value: string }> }, unknown: string): string {
  const values = sku.options.map((option) => option.value).join(" / ");
  const product = sku.productName ?? unknown;
  return values ? `${product} – ${values}` : product;
}

export function SkuThumbnail({ image }: { image: string | null }) {
  return (
    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
      {image ? (
        <img src={mediaImageUrl(image, 160)} alt="" className="size-full object-contain" loading="lazy" decoding="async" />
      ) : (
        <ImageIcon className="size-4 text-muted-foreground" aria-hidden="true" />
      )}
    </span>
  );
}

interface SkuPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `items`: a bundle's items (no gift card, no bundle, not itself); `offers`: other products' SKUs. */
  mode: "items" | "offers";
  /** The product being edited. */
  productId: string;
  /** Items mode: the bundle's own SKU. */
  kitVariantId?: string;
  /** SKUs already chosen: shown ticked and locked. */
  chosenIds: ReadonlySet<string>;
  /** How many more may be added. */
  capacity: number;
  onAdd: (skus: SkuOption[]) => void;
}

/**
 * Polaris's resource picker for SKUs: a server search by product, option or
 * SKU code (debounced), rows with picture, options, price and stock, the
 * SKUs a bundle or a page can't take locked with the reason, "N selected"
 * with Cancel and Add. Keyboard: Tab through the rows, Space ticks one.
 */
export function SkuPickerDialog({ open, onOpenChange, mode, productId, kitVariantId, chosenIds, capacity, onAdd }: SkuPickerDialogProps) {
  const t = useMessages(productKitMessages);
  const tr = useMessages(resourceMessages);
  const { fmt } = useCurrency();
  const [term, setTerm] = useState("");
  const [staged, setStaged] = useState<Map<string, SkuOption>>(() => new Map());
  const search = useDebounce(term.trim(), SEARCH_DEBOUNCE_MS);
  const query = useInfiniteQuery({ ...skuOptionsQueryOptions(search), enabled: open });
  const skus = useMemo(() => {
    const byId = new Map<string, SkuOption>();
    for (const page of query.data?.pages ?? []) for (const sku of page.items) byId.set(sku.variantId, sku);
    return [...byId.values()];
  }, [query.data]);
  const full = staged.size >= capacity;
  const loading = term.trim() !== search || query.isPending;

  const change = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setTerm("");
      setStaged(new Map());
    }
  };

  /** Why this SKU can't be chosen here, or null. */
  const refusal = (sku: SkuOption): ProductKitMessageKey | null => {
    if (mode === "offers") return sku.productId === productId ? "notAllowedOwn" : null;
    if (sku.variantId === kitVariantId) return "notAllowedSelf";
    if (sku.isGiftCard) return "notAllowedGiftCard";
    if (sku.isKit) return "notAllowedBundle";
    return null;
  };

  const toggle = (sku: SkuOption) => {
    setStaged((current) => {
      const next = new Map(current);
      if (next.has(sku.variantId)) next.delete(sku.variantId);
      else if (next.size < capacity) next.set(sku.variantId, sku);
      return next;
    });
  };

  const add = () => {
    if (staged.size === 0) return;
    onAdd([...staged.values()]);
    change(false);
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="gap-0 p-0 sm:max-w-200">
        <div className="flex flex-col gap-4 p-5">
          <DialogHeader>
            <DialogTitle>{t(mode === "items" ? "pickerItemsTitle" : "pickerOffersTitle")}</DialogTitle>
            <DialogDescription className="sr-only">{t("searchSkus")}</DialogDescription>
          </DialogHeader>
          <Input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder={t("searchSkus")}
            aria-label={t("searchSkus")}
          />
        </div>
        {/* A fixed box: filtering changes the rows, never the dialog's size. */}
        <div className="h-80 overflow-y-auto overscroll-contain border-t">
          {loading ? (
            <p role="status" className="flex items-center justify-center gap-2 px-5 py-10 text-body text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {t("searchingSkus")}
            </p>
          ) : query.isError && skus.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-5 py-10">
              <p className="text-body text-muted-foreground">{t("skusLoadFailed")}</p>
              <Button type="button" variant="outline" onClick={() => void query.refetch()}>{tr("retry")}</Button>
            </div>
          ) : skus.length === 0 ? (
            <p className="px-5 py-10 text-center text-body text-muted-foreground">
              {search ? t("noSkusMatch", { term: search }) : t("noSkusYet")}
            </p>
          ) : (
            <ul className="divide-y" aria-label={t(mode === "items" ? "pickerItemsTitle" : "pickerOffersTitle")}>
              {skus.map((sku) => {
                const added = chosenIds.has(sku.variantId);
                const reason = added ? null : refusal(sku);
                const checked = added || staged.has(sku.variantId);
                const locked = added || reason !== null || (!checked && full);
                const name = skuName(sku, sku.sku);
                return (
                  <li key={sku.variantId}>
                    <label className="flex min-h-14 cursor-pointer items-center gap-3 px-5 py-2 hover:bg-accent has-disabled:cursor-default">
                      <Checkbox
                        checked={checked}
                        disabled={locked}
                        onCheckedChange={() => toggle(sku)}
                        aria-label={name}
                        aria-describedby={reason ? `sku-reason-${sku.variantId}` : undefined}
                      />
                      <SkuThumbnail image={sku.imageUrl} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body font-medium" title={sku.productName}>{sku.productName}</span>
                        <span className="block truncate text-body text-muted-foreground">
                          {[optionLine(sku.options), sku.sku].filter(Boolean).join(" · ")}
                        </span>
                        {reason ? (
                          <span id={`sku-reason-${sku.variantId}`} className="block text-body text-muted-foreground">{t(reason)}</span>
                        ) : null}
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1 text-end">
                        <span className="text-body tabular-nums">{fmt(sku.price)}</span>
                        <span className="text-body tabular-nums text-muted-foreground">{availableStockText(sku.available)}</span>
                      </span>
                      <span className="hidden shrink-0 gap-1 sm:flex">
                        {added ? <Badge variant="secondary">{t("added")}</Badge> : null}
                        {sku.isKit ? <Badge variant="info">{t("bundle")}</Badge> : null}
                        {sku.isGiftCard ? <Badge variant="secondary">{t("giftCard")}</Badge> : null}
                        {sku.productActive ? null : <StatusBadge status="draft">{t("draft")}</StatusBadge>}
                      </span>
                    </label>
                  </li>
                );
              })}
              {query.hasNextPage ? (
                <li className="p-3">
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full"
                    loading={query.isFetchingNextPage}
                    onClick={() => void query.fetchNextPage()}
                  >
                    {query.isFetchNextPageError ? tr("retry") : t("loadMore")}
                  </Button>
                </li>
              ) : null}
            </ul>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3">
          <p className="text-body tabular-nums text-muted-foreground" aria-live="polite">
            {staged.size > 0 && full ? t("selectedLimit", { count: staged.size }) : tr("selected", { count: staged.size })}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => change(false)}>{tr("cancel")}</Button>
            <Button type="button" disabled={staged.size === 0} onClick={add}>{t("add")}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
