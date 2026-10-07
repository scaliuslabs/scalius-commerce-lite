import { isEventTopicFilter } from "@scalius/shared/events";
import type { BadgeVariant } from "~/components/ui/badge";
import { formatDateTime, formatNumber, translate } from "~/i18n";
import { webhookTopicMessages, webhooksMessages } from "~/i18n/settings-webhooks";
import type { WebhookDeliveryStatus, WebhookSubscription } from "~/lib/api-query-options/webhooks";
import { eventTime } from "~/lib/event-time";

/** A topic filter in plain words; an unknown one (a newer API) as sent. */
export function topicLabel(topic: string): string {
  return isEventTopicFilter(topic) ? translate(webhookTopicMessages, topic) : topic;
}

/** The host a webhook points at, for titles ("Delete the webhook to example.com?"). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function formatWhen(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return eventTime(date);
}

export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return ms < 1000
    ? translate(webhooksMessages, "durationMs", { value: formatNumber(Math.round(ms)) })
    : translate(webhooksMessages, "durationS", { value: formatNumber(ms / 1000, { maximumFractionDigits: 1 }) });
}

export function subscriptionStatus(subscription: WebhookSubscription): { label: string; variant: BadgeVariant } {
  if (subscription.status === "active") return { label: translate(webhooksMessages, "status_active"), variant: "success" };
  return subscription.disabledReason === "failing"
    ? { label: translate(webhooksMessages, "status_failing"), variant: "warning" }
    : { label: translate(webhooksMessages, "status_disabled"), variant: "secondary" };
}

export function deliveryStatusVariant(status: WebhookDeliveryStatus): BadgeVariant {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
    case "exhausted":
      return "destructive";
    case "cancelled":
      return "secondary";
    default:
      return "info";
  }
}

/** Still on its way: the result isn't known yet. */
export function isDeliveryInFlight(status: WebhookDeliveryStatus): boolean {
  return status === "pending" || status === "enqueueing" || status === "queued" || status === "processing";
}
