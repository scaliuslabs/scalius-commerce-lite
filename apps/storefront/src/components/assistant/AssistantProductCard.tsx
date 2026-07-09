import { ArrowUpRight, ImageIcon } from "lucide-react";

import type { AssistantMessagePart } from "@scalius/shared/assistant-contracts";
import { cn } from "@scalius/shared/utils";

export type AssistantProduct = Extract<
  AssistantMessagePart,
  { type: "product_grid" }
>["products"][number];

type AssistantProductCardProps = {
  product: AssistantProduct;
  compact?: boolean;
  canNavigate: (path: string) => boolean;
  onNavigate: (path: string, label: string) => void;
};

function formatMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

function availabilityLabel(value: AssistantProduct["availability"]): string {
  switch (value) {
    case "in_stock":
      return "In stock";
    case "out_of_stock":
      return "Out of stock";
    case "limited":
      return "Limited stock";
    case "unknown":
      return "Availability unknown";
  }
}

export function AssistantProductCard({
  product,
  compact = false,
  canNavigate,
  onNavigate,
}: AssistantProductCardProps) {
  const navigationAllowed = canNavigate(product.path);
  const currency = product.currency ?? "BDT";

  return (
    <article
      className={cn(
        "overflow-hidden rounded-xl border border-border/90 bg-background shadow-sm",
        compact ? "min-w-48" : "min-w-0",
      )}
    >
      <div
        className={cn(
          "relative overflow-hidden bg-muted",
          compact ? "aspect-[4/3]" : "aspect-[16/10]",
        )}
      >
        {product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="size-full object-cover transition-transform duration-300 motion-reduce:transition-none group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <ImageIcon className="size-6" aria-hidden="true" />
            <span className="sr-only">No product image</span>
          </div>
        )}
        <span
          className={cn(
            "absolute left-2 top-2 rounded-full border px-2 py-1 text-[10px] font-semibold backdrop-blur-sm",
            product.availability === "in_stock"
              ? "border-emerald-500/25 bg-emerald-50/90 text-emerald-800 dark:bg-emerald-950/85 dark:text-emerald-200"
              : product.availability === "limited"
                ? "border-amber-500/25 bg-amber-50/90 text-amber-800 dark:bg-amber-950/85 dark:text-amber-200"
                : "border-border bg-background/90 text-muted-foreground",
          )}
        >
          {availabilityLabel(product.availability)}
        </span>
      </div>

      <div className="grid gap-2 p-3">
        <div className="min-w-0">
          <h4 className="line-clamp-2 text-sm font-semibold leading-5 text-foreground">
            {product.title}
          </h4>
          {product.rationale ? (
            <p className="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground">
              {product.rationale}
            </p>
          ) : null}
        </div>

        {product.badges.length > 0 ? (
          <ul className="flex flex-wrap gap-1" aria-label="Product highlights">
            {product.badges.map((badge) => (
              <li
                key={badge}
                className="rounded-full bg-primary/9 px-2 py-0.5 text-[10px] font-medium text-primary"
              >
                {badge}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            {product.price !== undefined ? (
              <p className="text-sm font-bold tabular-nums text-foreground">
                {formatMoney(product.price, currency)}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">Price unavailable</p>
            )}
            {product.compareAtPrice !== undefined &&
            product.price !== undefined &&
            product.compareAtPrice > product.price ? (
              <p className="text-[11px] tabular-nums text-muted-foreground line-through">
                {formatMoney(product.compareAtPrice, currency)}
              </p>
            ) : null}
          </div>
          {navigationAllowed ? (
            <button
              type="button"
              aria-label={`View ${product.title}`}
              className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg bg-foreground px-3 text-xs font-semibold text-background transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              onClick={() => onNavigate(product.path, `View ${product.title}`)}
            >
              View
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
