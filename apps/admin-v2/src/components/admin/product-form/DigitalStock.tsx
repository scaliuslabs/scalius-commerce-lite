// A digital SKU's stock where a physical one has its quantity field: the
// licence keys left (with tracking) or unlimited downloads (without), and
// whether checkout accepts it yet. Never an input: keys move stock only
// through import and revoke, files are unlimited.
import { lazy, Suspense, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@scalius/shared/utils";
import { useCatalogActionPermissions } from "~/hooks/use-catalog-action-permissions";
import { useMessages } from "~/i18n";
import { digitalMessages } from "~/i18n/digital";
import { revealCard } from "./CollapsibleCard";
import { DIGITAL_CARD_ID, digitalAssetsKey, digitalAssetsQueryOptions, digitalSkuStock } from "./digital-stock";

// The import dialog's code loads on the first Import keys, then stays mounted.
const KeyImportDialog = lazy(() => import("./DigitalKeyDialogs").then((module) => ({ default: module.KeyImportDialog })));

function useDigitalSkuStock(productId: string | undefined, variantId: string | undefined) {
  const query = useQuery({ ...digitalAssetsQueryOptions(productId ?? ""), enabled: Boolean(productId) });
  // The SKU's key pool (made by its first import).
  const pool = query.data?.find((asset) => asset.kind === "licence_keys" && asset.variantId === variantId) ?? null;
  return {
    stock: query.data ? digitalSkuStock(variantId, query.data) : null,
    poolId: pool?.id ?? null,
    pending: Boolean(productId) && query.isPending,
  };
}

/**
 * The Inventory card's line for a digital product without options. Import
 * keys opens the import dialog right here; Add file opens the Digital
 * delivery card, where files are uploaded.
 */
export function DigitalStockStatus({ productId, variantId, tracked }: {
  /** Unset while the product is being added. */
  productId: string | undefined;
  variantId: string | undefined;
  tracked: boolean;
}) {
  const t = useMessages(digitalMessages);
  const queryClient = useQueryClient();
  const { products: { canEdit } } = useCatalogActionPermissions();
  const { stock, poolId, pending } = useDigitalSkuStock(productId, variantId);
  const [importing, setImporting] = useState(false);
  const [dialogLoaded, setDialogLoaded] = useState(false);
  if (!productId) {
    return <p className="text-body text-warning">{t("stockSaveFirst")}</p>;
  }
  if (pending) return <Skeleton className="h-5 w-56" />;
  const facts = tracked
    ? stock?.keys != null ? t("stockKeys", { count: stock.keys }) : t("stockNoKeys")
    : stock?.file ? t("stockUnlimited") : t("stockNoFile");
  const problem = !stock || stock.sellable
    ? null
    : tracked && stock.keys === 0 ? t("stockOutOfKeys") : t("stockNotSellable");
  // Keys can always be imported (the first ones start tracking: they are the stock);
  // a SKU without keys can also deliver files.
  const actionClass = "rounded-sm text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <div className="space-y-1" data-testid="digital-stock">
      <p className="flex flex-wrap items-center gap-x-1 text-body">
        <span className="tabular-nums">{facts}</span>
        {canEdit && variantId ? (
          <>
            <span aria-hidden="true" className="text-muted-foreground">·</span>
            <button
              type="button"
              className={actionClass}
              onClick={() => {
                setDialogLoaded(true);
                setImporting(true);
              }}
            >
              {t("importKeys")}
            </button>
          </>
        ) : null}
        {canEdit && !tracked ? (
          <>
            <span aria-hidden="true" className="text-muted-foreground">·</span>
            <button type="button" className={actionClass} onClick={() => revealCard(DIGITAL_CARD_ID)}>
              {t("addFile")}
            </button>
          </>
        ) : null}
      </p>
      {problem ? <p className="text-body text-warning">{problem}</p> : null}
      {dialogLoaded && variantId ? (
        <Suspense fallback={null}>
          <KeyImportDialog
            productId={productId}
            target={importing ? { variantId, label: null, poolId } : null}
            onOpenChange={(open) => { if (!open) setImporting(false); }}
            onChanged={() => void queryClient.invalidateQueries({ queryKey: digitalAssetsKey(productId) })}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

/** The variant table's quantity cell for a digital variant: "12 keys", "Unlimited" or "Not ready". */
export function DigitalStockCell({ productId, variantId, tracked }: {
  productId: string | undefined;
  variantId: string;
  tracked: boolean;
}) {
  const t = useMessages(digitalMessages);
  const { stock, pending } = useDigitalSkuStock(productId, variantId.startsWith("draft_") ? undefined : variantId);
  if (pending) return <Skeleton className="my-2 h-5 w-16" />;
  const ready = Boolean(stock?.sellable);
  const text = !ready
    ? t("stockCellNotReady")
    : tracked && stock?.keys != null ? t("stockCellKeys", { count: stock.keys }) : t("stockCellUnlimited");
  return (
    <p
      className={cn("py-2 text-body tabular-nums", ready ? "text-muted-foreground" : "text-warning")}
      title={ready ? undefined : t("stockNotSellable")}
    >
      {text}
    </p>
  );
}
