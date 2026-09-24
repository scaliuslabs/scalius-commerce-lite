import type { OrderNotificationOutboxDto, OrderNotificationReceiptDto } from "./api-query-options/orders";

/** Why a customer message didn't go out, in words a merchant can act on. */
export type NotificationIssue =
  | "noEmail"
  | "noPhone"
  | "smsNotSetUp"
  | "whatsappNotSetUp"
  | "providerSetup"
  | "stopped"
  | "other";

/** Missing a recipient or a channel setup: sending again can't help. */
const UNSENDABLE_ISSUES = new Set<NotificationIssue>(["noEmail", "noPhone", "smsNotSetUp", "whatsappNotSetUp"]);

const SUCCESSFUL = new Set(["accepted", "delivered"]);

/** Maps the recorded provider text or code to one merchant-facing reason. */
export function notificationIssue(value: string | null | undefined): NotificationIssue | null {
  const text = value?.trim().toLowerCase();
  if (!text) return null;
  if (text.includes("missing_email_recipient") || text.includes("missing email")) return "noEmail";
  if (/missing_(sms|whatsapp)_recipient|invalid_whatsapp_recipient|missing sms recipient/.test(text)) return "noPhone";
  if (text.includes("missing_sms_provider")) return "smsNotSetUp";
  if (text.includes("missing_whatsapp_credentials")) return "whatsappNotSetUp";
  if (/attempt_limit_reached|dlq_terminal/.test(text)) return "stopped";
  if (
    /provider_blocked_until_settings_save|credential|could not be decrypted|api key|invalid token|invalid_grant|service account|private key|unauthori[sz]ed|authorization required|authentication failed|forbidden|sender|balance|credit/.test(text)
    || /\b(?:http|status|code|error)[^0-9]*(?:400|401|402|403|404|405|422)\b/.test(text)
  ) {
    return "providerSetup";
  }
  return "other";
}

/** One status for the whole message, from what each channel recorded. */
export function summarizeNotificationDelivery(
  outbox: Pick<OrderNotificationOutboxDto, "status" | "receipts">,
): string {
  const statuses = outbox.receipts.map((receipt) => receipt.status);
  if (statuses.length === 0) return outbox.status;
  const all = (predicate: (status: string) => boolean) => statuses.every(predicate);
  const some = (...values: string[]) => statuses.some((status) => values.includes(status));
  if (all((status) => status === "delivered")) return "delivered";
  if (all((status) => SUCCESSFUL.has(status))) return "accepted";
  if (all((status) => status === "skipped")) return "skipped";
  if (all((status) => status === "failed")) return "failed";
  if (some("accepted", "delivered") && some("failed", "skipped")) return "partial";
  if (some("pending", "queued", "enqueueing", "processing")) return "pending";
  if (some("failed")) return "failed";
  if (some("skipped")) return "skipped";
  return outbox.status;
}

export interface NotificationChannelLine {
  key: string;
  channel: string;
  status: string;
  /** Masked recipient, or null when several recipients share the line. */
  recipient: string | null;
  count: number;
  issue: NotificationIssue | null;
}

/** One line per channel and outcome, e.g. "Email · r***@mail.com · Sent". Staff push devices are left out. */
export function notificationChannelLines(receipts: readonly OrderNotificationReceiptDto[]): NotificationChannelLine[] {
  const lines = new Map<string, NotificationChannelLine>();
  for (const receipt of receipts) {
    if (receipt.channel === "push") continue;
    const issue = SUCCESSFUL.has(receipt.status) ? null : notificationIssue(receipt.lastError ?? receipt.providerStatus);
    const key = [receipt.channel, receipt.status, issue ?? ""].join("|");
    // "missing-email" is the server's placeholder when there is no recipient.
    const recipient = receipt.recipientMasked?.startsWith("missing-") ? null : receipt.recipientMasked;
    const line = lines.get(key);
    if (line) {
      line.count += 1;
      if (line.recipient !== recipient) line.recipient = null;
    } else {
      lines.set(key, { key, channel: receipt.channel, status: receipt.status, recipient, count: 1, issue });
    }
  }
  return [...lines.values()];
}

/**
 * Whether sending (again) can reach the customer: not when every channel
 * lacks a recipient or isn't set up.
 */
export function canSendNotificationAgain(outbox: Pick<OrderNotificationOutboxDto, "lastError" | "receipts">): boolean {
  const lines = notificationChannelLines(outbox.receipts);
  if (lines.length === 0) {
    const issue = notificationIssue(outbox.lastError);
    return !issue || !UNSENDABLE_ISSUES.has(issue);
  }
  return lines.some((line) => !line.issue || !UNSENDABLE_ISSUES.has(line.issue));
}
