import { isEventTopicFilter } from "@scalius/shared/events";
import type { BadgeVariant } from "~/components/ui/badge";
import { formatDateTime, formatNumber, translate } from "~/i18n";
import { webhookTopicMessages, webhooksMessages } from "~/i18n/settings-webhooks";
import type { WebhookDeliveryStatus, WebhookSubscription } from "~/lib/api-query-options/webhooks";

/** A topic filter in plain words; an unknown one (a newer API) as sent. */
export function topicLabel(topic: string): string {
  return isEventTopicFilter(topic) ? translate(webhookTopicMessages, topic) : topic;
}

/**
 * A delivery's error in plain words, with the raw one (codes, references) as
 * the detail. The API records machine-readable reasons (`network_error: …`,
 * `timeout: …`, `http_502`, `redirect_not_followed: …`, `url_refused: …`,
 * core webhook-delivery.ts); an unknown reason shows as sent.
 */
export function deliveryErrorText(error: string): { text: string; detail: string | null } {
  const t = (key: keyof (typeof webhooksMessages)["en"], vars?: Record<string, string>) => translate(webhooksMessages, key, vars);
  const http = /^http_(\d{3})$/.exec(error);
  if (http) return { text: t(Number(http[1]) >= 500 ? "errorServer" : "errorRefused", { code: http[1]! }), detail: null };
  if (error.startsWith("network_error")) return { text: t("errorNetwork"), detail: error };
  if (error.startsWith("timeout")) return { text: t("errorTimeout"), detail: error };
  if (error.startsWith("redirect_not_followed")) return { text: t("errorRedirect"), detail: null };
  if (error.startsWith("url_refused")) return { text: t("errorUrlRefused"), detail: error };
  return { text: error, detail: null };
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
  return formatDateTime(date, { dateStyle: "medium", timeStyle: "short" });
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
  return status === "pending" || status === "processing";
}
