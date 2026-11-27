// A line's delivery message (rules/orders/buyer-line-delivery-message.md): the
// store's own words for this item (a sign-in, an instruction, a link), as
// secret as a licence key. Only the signed-in account's order names one
// (`extras.message`: an id and a date, never its text); the buyer reveals it
// with a POST form carrying the id only, which `pages/account/delivery-message`
// answers on a no-store page. A receipt page never shows one, not even that
// one exists: the API does not send it there, and this renders nothing for it.
import type { LineExtrasContext, OrderLine } from "@/lib/order-line-extras";
import { downloadCopy, isDigitalId } from "@/lib/account-downloads";
import { escapeHtml } from "@scalius/shared/html-escape";
import { pagePath } from "@/lib/presence-url";

/** `extras.message` (OrderLineMessageExtra): the message by id; its text and link only through the reveal. */
export interface DeliveryMessageExtra {
  messageId: string;
  hasLink: boolean;
  updatedAt?: string;
}

export function readDeliveryMessage(value: unknown): DeliveryMessageExtra | null {
  if (!value || typeof value !== "object") return null;
  const { messageId, hasLink, updatedAt } = value as Record<string, unknown>;
  if (!isDigitalId(messageId)) return null;
  return { messageId, hasLink: hasLink === true, ...(typeof updatedAt === "string" ? { updatedAt } : {}) };
}

const BUTTON = "inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted";

export function deliveryMessageLineMarkup(line: OrderLine, context: LineExtrasContext): string {
  if (context.access !== "account") return "";
  const message = readDeliveryMessage(line.extras?.message);
  if (!message) return "";
  const copy = downloadCopy();
  const returnTo = pagePath(`/account/orders/${encodeURIComponent(context.orderId)}`);
  const fields = { messageId: message.messageId, returnTo };
  const hidden = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`)
    .join("");
  const facts = [copy.messageHint, message.hasLink ? copy.messageHasLink : ""].filter(Boolean).join(" · ");
  return `<div class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background p-3" role="group" aria-label="${escapeHtml(copy.messageHeading)}" data-delivery-message data-part="delivery-message">
    <div class="min-w-0 flex-1">
      <p class="text-sm font-medium text-foreground">${escapeHtml(copy.messageHeading)}</p>
      <p class="text-sm text-muted-foreground">${escapeHtml(facts)}</p>
    </div>
    <form method="post" action="/account/delivery-message">${hidden}<button type="submit" class="${BUTTON}" data-control="action" data-part="delivery-reveal">${escapeHtml(copy.showMessage)}<span class="sr-only"> (${escapeHtml(line.productName ?? copy.productFallback)})</span></button></form>
  </div>`;
}
