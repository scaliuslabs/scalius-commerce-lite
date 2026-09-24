// Where an order is, as HTML: the step tracker, the dated updates and each
// shipment's courier. The account order page renders it in the browser; the
// receipt's status view renders the same markup on the server.
import { escapeHtml } from "@scalius/shared/html-escape";
import type { CustomerOrderProgress, CustomerOrderTimelineEvent } from "@/lib/api/customer-auth";

export interface OrderTrackingText {
  /** Read after a finished step: "done". */
  done: string;
  trackingId: string;
  trackWithCourier: string;
  formatDate: (iso: string) => string;
}

export interface OrderTrackingShipment {
  statusLabel: string;
  courier: string | null;
  trackingId: string | null;
  /** Already checked with `safeTrackingUrl`. */
  trackingUrl: string | null;
  /** "Updated 24 Sep 2026, 5:46 AM" line, when the page has one. */
  updated?: string | null;
}

/** An http(s) link, else null; relative links resolve against `base`. */
export function safeTrackingUrl(url: string | null | undefined, base?: string): string | null {
  if (!url) return null;
  try {
    const parsed = base ? new URL(url, base) : new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** The four steps, or the outcome (cancelled, returned…) in their place. */
export function orderProgressMarkup(progress: CustomerOrderProgress, text: OrderTrackingText): string {
  const { steps, outcome } = progress;
  if (outcome) {
    return `<p class="text-base font-semibold text-foreground">${escapeHtml(outcome.label)}</p>${outcome.happenedAt ? `<p class="text-sm text-muted-foreground">${escapeHtml(text.formatDate(outcome.happenedAt))}</p>` : ""}`;
  }
  const current = steps.reduce((last, step, index) => (step.done ? index : last), 0);
  return `<ol class="grid grid-cols-4 gap-2">${steps.map((step, index) => `
    <li class="flex flex-col gap-2" ${index === current ? 'aria-current="step"' : ""}>
      <span class="h-1.5 rounded-full ${step.done ? "bg-primary" : "bg-muted"}" aria-hidden="true"></span>
      <span class="text-sm ${step.done ? "font-medium text-foreground" : "text-muted-foreground"}">${escapeHtml(step.label)}${step.done && index !== current ? `<span class="sr-only"> (${escapeHtml(text.done)})</span>` : ""}</span>
    </li>`).join("")}</ol>`;
}

/** The `<li>` items of a dated timeline, newest first as the API sends them. */
export function orderTimelineMarkup(events: readonly CustomerOrderTimelineEvent[], text: OrderTrackingText): string {
  return events.map((event) => `
    <li>
      <p class="text-sm font-medium text-foreground">${escapeHtml(event.label)}</p>
      ${event.details ? `<p class="text-sm text-muted-foreground">${escapeHtml(event.details)}</p>` : ""}
      ${event.happenedAt ? `<time class="text-sm text-muted-foreground" datetime="${escapeHtml(event.happenedAt)}">${escapeHtml(text.formatDate(event.happenedAt))}</time>` : ""}
    </li>`).join("");
}

export function orderShipmentMarkup(shipment: OrderTrackingShipment, text: OrderTrackingText): string {
  return `<article class="rounded-lg border border-border p-4 text-sm">
    <p class="font-medium text-foreground">${escapeHtml([shipment.statusLabel, shipment.courier].filter(Boolean).join(" · "))}</p>
    ${shipment.trackingId ? `<p class="text-muted-foreground">${escapeHtml(text.trackingId)} <span class="font-mono">${escapeHtml(shipment.trackingId)}</span></p>` : ""}
    ${shipment.trackingUrl ? `<a href="${escapeHtml(shipment.trackingUrl)}" target="_blank" rel="noopener noreferrer" data-astro-prefetch="false" class="inline-flex min-h-11 items-center font-medium text-primary hover:underline">${escapeHtml(text.trackWithCourier)}</a>` : ""}
    ${shipment.updated ? `<p class="text-muted-foreground">${escapeHtml(shipment.updated)}</p>` : ""}
  </article>`;
}
