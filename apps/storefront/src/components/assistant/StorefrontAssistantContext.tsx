import {
  BookOpenText,
  LockKeyhole,
  PackageSearch,
  ShoppingBag,
} from "lucide-react";

import type { StorefrontAssistantPageContextSnapshot } from "@/lib/assistant-page-context";

const SENSITIVE_PAGE_KINDS = new Set(["account", "checkout"]);

type StorefrontAssistantContextProps = {
  context: StorefrontAssistantPageContextSnapshot | null;
};

function titleCase(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function surfaceSummary(
  context: StorefrontAssistantPageContextSnapshot | null,
): string {
  const surface = context?.surface;
  if (!surface) return "No item-specific context is available.";

  switch (surface.kind) {
    case "product":
      if (surface.availability === "selection_required") {
        return "This product needs an option selection.";
      }
      return `This product is ${surface.availability.replaceAll("_", " ")}.`;
    case "search":
      return `${surface.totalResults} results for “${surface.query}”.`;
    case "category":
    case "collection":
      return `${surface.totalResults} products in this ${surface.kind}.`;
    case "cart":
      return `${surface.totalItems} items across ${surface.lineCount} cart lines.`;
  }
}

function pageSummary(
  context: StorefrontAssistantPageContextSnapshot | null,
): string {
  if (!context) return "Waiting for this page";
  if (SENSITIVE_PAGE_KINDS.has(context.page.kind)) {
    return `${titleCase(context.page.kind)} · private context protected`;
  }
  return `${context.page.title || titleCase(context.page.kind)} · ${titleCase(context.page.kind)}`;
}

export function StorefrontAssistantContext({
  context,
}: StorefrontAssistantContextProps) {
  const privateContext = SENSITIVE_PAGE_KINDS.has(context?.page.kind ?? "");
  const cartItems = context?.cart.totalItems ?? 0;

  return (
    <details className="group border-b border-border/80 bg-muted/35">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
          {privateContext ? (
            <LockKeyhole className="size-3.5" aria-hidden="true" />
          ) : (
            <PackageSearch className="size-3.5" aria-hidden="true" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Current page
          </span>
          <span className="block truncate text-xs font-medium text-foreground">
            {pageSummary(context)}
          </span>
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-background px-2 py-1 text-[11px] font-semibold tabular-nums text-foreground">
          <ShoppingBag className="size-3" aria-hidden="true" />
          {cartItems}
          <span className="sr-only">items in cart</span>
        </span>
      </summary>

      <div className="grid gap-2 border-t border-border/60 px-4 py-3 text-xs leading-5 text-muted-foreground">
        <div className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2">
          <BookOpenText
            className="mt-0.5 size-3.5 text-primary"
            aria-hidden="true"
          />
          <p className="break-words">
            {privateContext
              ? "Only the page type is shared with the assistant. Account and checkout details stay private."
              : context
                ? `${context.page.path} · ${surfaceSummary(context)}`
                : "Page context has not loaded yet. General catalog questions still work."}
          </p>
        </div>
        <div className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2">
          <ShoppingBag
            className="mt-0.5 size-3.5 text-primary"
            aria-hidden="true"
          />
          <p>
            {context
              ? `${context.cart.totalItems} items across ${context.cart.lineCount} lines${context.cart.hasDiscount ? "; a discount is present" : ""}.`
              : "Cart summary unavailable."}
          </p>
        </div>
      </div>
    </details>
  );
}
