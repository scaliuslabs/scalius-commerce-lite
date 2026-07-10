import type { FlueConversationPart } from "@flue/sdk";
import {
  AssistantShortAnswer,
  AssistantToolProgress,
} from "@scalius/ui/assistant";
import { ArrowUpRight, ImageIcon } from "lucide-react";

const MAX_VISIBLE_TOOL_ROWS = 2;
const MAX_VISIBLE_TEXT_CHARACTERS = 2_000;
const MAX_VISIBLE_PRODUCTS = 3;

type StorefrontFlueCatalogProduct = {
  id: string;
  name: string;
  route: string;
  imageUrl?: string;
  price?: number;
  compareAtPrice?: number;
  currency?: string;
  availableForSale: boolean;
};

function cleanText(value: string): string {
  return Array.from(value.replace(/\r\n?/g, "\n"), (character) => {
    if (character === "\n" || character === "\t") return character;
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  })
    .join("")
    .replace(/[\u2028\u2029]/g, " ")
    .trim()
    .slice(0, MAX_VISIBLE_TEXT_CHARACTERS);
}

function toolLabel(
  part: Extract<
    FlueConversationPart,
    {
      type: "dynamic-tool";
    }
  >,
): string {
  if (part.toolName === "computer") {
    if (part.state === "input-available") return "Using this page";
    if (part.state === "output-error") return "Page action needs attention";
    return "Page action finished";
  }
  if (part.toolName === "scalius") {
    if (part.state === "input-available") return "Checking the catalog";
    if (part.state === "output-error") return "Catalog check needs attention";
    return "Catalog checked";
  }
  return part.state === "input-available"
    ? "Working"
    : part.state === "output-error"
      ? "Step needs attention"
      : "Step finished";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const text = cleanText(value).replace(/\s+/gu, " ").slice(0, maximum).trim();
  return text || null;
}

function safeProductRoute(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^\/products\/[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/u.test(value)
    ? value
    : null;
}

function safeImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function safePrice(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function parseCatalogProduct(
  value: unknown,
  currency: string | undefined,
): StorefrontFlueCatalogProduct | null {
  if (!isRecord(value)) return null;
  const route = safeProductRoute(value.route);
  const name = compactText(value.name, 180);
  if (!route || !name) return null;
  const currentPrice = safePrice(value.currentPrice);
  const originalPrice = safePrice(value.price);
  const price = currentPrice ?? originalPrice;
  const imageUrl =
    safeImageUrl(value.imageUrl) ??
    (Array.isArray(value.images) && isRecord(value.images[0])
      ? safeImageUrl(value.images[0].url)
      : undefined);
  return {
    id: compactText(value.id, 160) ?? route,
    name,
    route,
    ...(imageUrl ? { imageUrl } : {}),
    ...(price !== undefined ? { price } : {}),
    ...(originalPrice !== undefined &&
    price !== undefined &&
    originalPrice > price
      ? { compareAtPrice: originalPrice }
      : {}),
    ...(currency ? { currency } : {}),
    availableForSale: value.availableForSale === true,
  };
}

export function projectStorefrontFlueCatalogProducts(
  parts: readonly FlueConversationPart[],
): StorefrontFlueCatalogProduct[] {
  const products: StorefrontFlueCatalogProduct[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (
      part.type !== "dynamic-tool" ||
      part.toolName !== "scalius" ||
      part.state !== "output-available" ||
      !isRecord(part.output) ||
      part.output.ok !== true ||
      part.output.authoritative !== true ||
      !isRecord(part.output.data) ||
      part.output.data.command !== "call" ||
      !isRecord(part.output.data.capability) ||
      !["catalog.search", "catalog.list", "catalog.product"].includes(
        String(part.output.data.capability.id),
      ) ||
      !isRecord(part.output.data.result)
    ) {
      continue;
    }
    const result = part.output.data.result;
    const currency = isRecord(result.currency) &&
        typeof result.currency.code === "string" &&
        /^[A-Z]{3}$/u.test(result.currency.code)
      ? result.currency.code
      : undefined;
    const candidates = Array.isArray(result.products)
      ? result.products
      : result.product
        ? [result.product]
        : [];
    for (const candidate of candidates) {
      const product = parseCatalogProduct(candidate, currency);
      if (!product || seen.has(product.route)) continue;
      seen.add(product.route);
      products.push(product);
      if (products.length >= MAX_VISIBLE_PRODUCTS) return products;
    }
  }
  return products;
}

function formatPrice(product: StorefrontFlueCatalogProduct): string | null {
  if (product.price === undefined || !product.currency) return null;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: product.currency,
    }).format(product.price);
  } catch {
    return `${product.currency} ${product.price}`;
  }
}

function CatalogResults({
  products,
  canNavigate,
  onNavigate,
}: {
  products: readonly StorefrontFlueCatalogProduct[];
  canNavigate: (route: string) => boolean;
  onNavigate: (route: string) => void;
}) {
  if (products.length === 0) return null;
  return (
    <section aria-label="Catalog results">
      <ul className="grid gap-1.5">
        {products.map((product) => {
          const price = formatPrice(product);
          return (
            <li
              key={product.id}
              className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-background p-2"
            >
              <span className="flex size-12 shrink-0 overflow-hidden rounded-lg bg-muted">
                {product.imageUrl ? (
                  <img
                    src={product.imageUrl}
                    alt=""
                    width={48}
                    height={48}
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                    className="size-full object-cover"
                  />
                ) : (
                  <ImageIcon
                    className="m-auto size-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-foreground">
                  {product.name}
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                  {[price, product.availableForSale ? "In stock" : "Out of stock"]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              {canNavigate(product.route) ? (
                <button
                  type="button"
                  aria-label={`View ${product.name}`}
                  title={`View ${product.name}`}
                  onClick={() => onNavigate(product.route)}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-foreground transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function StorefrontFlueMessageParts({
  parts,
  canNavigate = () => false,
  onNavigate = () => undefined,
}: {
  parts: readonly FlueConversationPart[];
  canNavigate?: (route: string) => boolean;
  onNavigate?: (route: string) => void;
}) {
  const text = cleanText(
    parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n"),
  );
  const allToolParts = parts.filter(
      (
        part,
      ): part is Extract<
        FlueConversationPart,
        {
          type: "dynamic-tool";
        }
      > => part.type === "dynamic-tool",
    );
  const products = projectStorefrontFlueCatalogProducts(parts);
  const unsettledToolParts = allToolParts.filter(
    (part) =>
      part.state === "input-available" || part.state === "output-error",
  );
  const toolParts = (unsettledToolParts.length > 0
    ? unsettledToolParts
    : text || products.length > 0
      ? []
      : allToolParts.slice(-1)
  ).slice(-MAX_VISIBLE_TOOL_ROWS);
  return (
    <div className="grid gap-2.5">
      {text ? (
        <AssistantShortAnswer
          summary={text}
          details={
            text.length > 420 ? (
              <p className="max-h-72 overflow-auto whitespace-pre-wrap break-words pr-1">
                {text}
              </p>
            ) : undefined
          }
        />
      ) : null}

      <CatalogResults
        products={products}
        canNavigate={canNavigate}
        onNavigate={onNavigate}
      />

      {toolParts.length > 0 ? (
        <AssistantToolProgress
          label="Assistant work"
          steps={toolParts.map((part) => ({
            id: part.toolCallId,
            label: toolLabel(part),
            status:
              part.state === "input-available"
                ? ("running" as const)
                : part.state === "output-error"
                  ? ("failed" as const)
                  : ("complete" as const),
          }))}
        />
      ) : null}

      {!text && products.length === 0 && toolParts.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          This assistant message had no displayable content.
        </p>
      ) : null}
    </div>
  );
}
