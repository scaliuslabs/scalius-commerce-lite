import type { ConversationProductCard } from "@scalius/shared/conversation";
import { currencySymbol } from "@scalius/shared/money-format";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { formatNumber, useMessages } from "~/i18n";
import { inboxMessages } from "~/i18n/inbox";

export function ConversationAmount({ amount, currency }: { amount: number; currency: string }) {
  return <span className="tabular-nums">{currencySymbol(currency)}{formatNumber(amount, { minimumFractionDigits: getDecimalPlaces(currency), maximumFractionDigits: getDecimalPlaces(currency) })}</span>;
}
/** The API projects live buyer facts; missing price/link remains unavailable, never guessed. */
export function ConversationProductCards({ products }: { products: readonly ConversationProductCard[] }) {
  const t = useMessages(inboxMessages);
  return <ul className="flex min-w-0 flex-col gap-2">
    {products.map((product) => <li key={`${product.productId}:${product.skuId}`} className="flex min-w-0 gap-3 rounded-lg border bg-card p-2">
      {product.imageUrl ? <img src={product.imageUrl} alt="" loading="lazy" className="size-12 shrink-0 rounded-md object-cover" /> : null}
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 wrap-anywhere font-medium">{product.title}</p>
        {product.variantLabel ? <p className="wrap-anywhere text-body text-muted-foreground">{product.variantLabel}</p> : null}
        {product.price ? <ConversationAmount {...product.price} /> : null}
        {product.status !== "available" ? <p className="text-body text-muted-foreground">{t(product.status === "sold_out" ? "soldOut" : "productUnavailable")}</p> : null}
        {product.pdpUrl ? <a href={product.pdpUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center text-link hover:underline sm:min-h-6">{t("viewProduct")}</a> : null}
      </div>
    </li>)}
  </ul>;
}
