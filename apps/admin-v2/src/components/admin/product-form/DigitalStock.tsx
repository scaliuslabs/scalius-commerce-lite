// A digital SKU's stock where a physical one has its quantity field: the
// licence keys left (with tracking) or unlimited downloads (without), and
// whether checkout accepts it yet. Never an input: keys move stock only
// through import and revoke, files are unlimited.
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@scalius/shared/utils";
import { formatNumber, useMessages } from "~/i18n";
import { digitalMessages } from "~/i18n/digital";
import { revealCard } from "./CollapsibleCard";
import { DIGITAL_CARD_ID, digitalAssetsQueryOptions, digitalSkuStock } from "./digital-stock";

function useDigitalSkuStock(productId: string | undefined, variantId: string | undefined) {
  const query = useQuery({ ...digitalAssetsQueryOptions(productId ?? ""), enabled: Boolean(productId) });
  return { stock: query.data ? digitalSkuStock(variantId, query.data) : null, pending: Boolean(productId) && query.isPending };
}

/** The Inventory card's line for a digital product without options. */
export function DigitalStockStatus({ productId, variantId, tracked }: {
  /** Unset while the product is being added. */
  productId: string | undefined;
  variantId: string | undefined;
  tracked: boolean;
}) {
  const t = useMessages(digitalMessages);
  const { stock, pending } = useDigitalSkuStock(productId, variantId);
  if (!productId) {
    return <p className="text-body text-warning">{t("stockSaveFirst")}</p>;
  }
  if (pending) return <Skeleton className="h-5 w-56" />;
  const facts = tracked
    ? stock?.keys != null ? t("stockKeys", { count: formatNumber(stock.keys) }) : t("stockNoKeys")
    : stock?.file ? t("stockUnlimited") : t("stockNoFile");
  const problem = !stock || stock.sellable
    ? null
    : tracked && stock.keys === 0 ? t("stockOutOfKeys") : t("stockNotSellable");
  return (
    <div className="space-y-1" data-testid="digital-stock">
      <p className="flex flex-wrap items-center gap-x-1 text-body">
        <span className="tabular-nums">{facts}</span>
        <span aria-hidden="true" className="text-muted-foreground">·</span>
        <button
          type="button"
          className="rounded-sm text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => revealCard(DIGITAL_CARD_ID)}
        >
          {t(tracked ? "importKeys" : "addFile")}
        </button>
      </p>
      {problem ? <p className="text-body text-warning">{problem}</p> : null}
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
    : tracked && stock?.keys != null ? t("stockCellKeys", { count: formatNumber(stock.keys) }) : t("stockCellUnlimited");
  return (
    <p
      className={cn("py-2 text-body tabular-nums", ready ? "text-muted-foreground" : "text-warning")}
      title={ready ? undefined : t("stockNotSellable")}
    >
      {text}
    </p>
  );
}
