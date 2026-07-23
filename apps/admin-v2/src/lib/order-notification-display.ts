import type { OrderNotificationOutboxDto, OrderNotificationReceiptDto } from "./api-functions/orders";

export interface OrderNotificationReceiptDisplayGroup {
  key: string;
  receipts: OrderNotificationReceiptDto[];
  channel: string;
  provider: string;
  status: string;
  count: number;
  recipientLabel: string;
  providerStatus: string | null;
  lastError: string | null;
  showLastError: boolean;
  latestTimestamp: string | number | null;
  totalAttempts: number;
  maxAttempts: number;
  setupIssue: boolean;
}

const TERMINAL_DELIVERY_STATUSES = new Set(["accepted", "delivered", "skipped"]);
const TERMINAL_OUTBOX_STATUSES = new Set(["sent"]);

export function describeNotificationIssue(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text) return null;
  const normalized = text.toLowerCase();

  if (normalized.includes("missing_email_recipient") || normalized.includes("missing email")) {
    return "Customer email was not collected for this order.";
  }
  if (normalized.includes("missing_sms_recipient") || normalized.includes("missing sms recipient")) {
    return "Customer phone was not available for SMS delivery.";
  }
  if (normalized.includes("missing_sms_provider")) {
    return "SMS is enabled, but no active SMS provider is ready.";
  }
  if (normalized.includes("missing_whatsapp_credentials")) {
    return "WhatsApp is enabled, but Meta Cloud API credentials are not ready.";
  }
  if (normalized.includes("missing_whatsapp_recipient")) {
    return "Customer phone was not available for WhatsApp delivery.";
  }
  if (normalized.includes("invalid_whatsapp_recipient")) {
    return "Customer phone could not be formatted for WhatsApp delivery.";
  }
  if (normalized.includes("could not be decrypted")) {
    return "Saved credentials cannot be decrypted. Save the provider credentials again.";
  }
  if (
    normalized.includes("invalid_grant") ||
    normalized.includes("service account") ||
    normalized.includes("private key")
  ) {
    return "Firebase credentials are not usable. Save a valid service account or disable admin push notifications.";
  }
  if (normalized.includes("provider_blocked_until_settings_save")) {
    return "Provider sending is paused after a setup failure. Save corrected provider settings to resume notifications.";
  }
  if (
    normalized.includes("authorization required") ||
    normalized.includes("unauthorized") ||
    normalized.includes("authentication failed") ||
    normalized.includes("forbidden") ||
    /\b(?:resend api error|http|status|code|error)[^0-9]*(?:401|403|405)\b/.test(normalized)
  ) {
    return "Provider rejected the saved credentials. Save valid credentials or disable this channel.";
  }
  if (
    normalized.includes("invalid api key") ||
    normalized.includes("invalid token") ||
    normalized.includes("invalid credential") ||
    normalized.includes("mismatched credential")
  ) {
    return "Provider rejected the API key or token. Save valid credentials or disable this channel.";
  }
  if (/\b(?:http|status|code|error)[^0-9]*(?:400|402|404|422)\b/.test(normalized)) {
    return "Provider rejected the notification setup. Check credentials, template, sender, and channel settings.";
  }
  if (normalized.includes("balance") || normalized.includes("credit")) {
    return "SMS provider balance or credit is not ready. Recharge it or disable SMS notifications.";
  }
  if (normalized.includes("sender")) {
    return "Provider rejected the sender ID. Use an approved sender or disable this channel.";
  }
  if (normalized.includes("delivery_attempt_limit_reached")) {
    return "Delivery stopped after repeated provider failures. Check credentials and settings before sending more notifications.";
  }
  if (normalized.includes("order_notification_attempt_limit_reached")) {
    return "Notification retry stopped after repeated failures before delivery could settle. Check provider settings before retrying.";
  }
  if (normalized.includes("order_notification_dlq_terminal")) {
    return "Notification queue delivery exhausted its safety retries. Check provider settings before retrying.";
  }
  if (normalized.includes("delivery_receipt_busy")) {
    return "A previous retry is still cooling down; the outbox will not resend before its schedule.";
  }

  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export function buildReceiptDisplayGroups(
  receipts: OrderNotificationReceiptDto[],
): OrderNotificationReceiptDisplayGroup[] {
  const groups = new Map<string, OrderNotificationReceiptDto[]>();

  for (const receipt of receipts) {
    const key = [
      receipt.channel,
      receipt.provider,
      receipt.status,
      displayGroupingIssueKey(receipt.providerStatus),
      displayGroupingIssueKey(receipt.lastError),
    ].join("|");
    groups.set(key, [...(groups.get(key) ?? []), receipt]);
  }

  return Array.from(groups.entries()).map(([key, groupedReceipts]) => {
    const first = groupedReceipts[0] as OrderNotificationReceiptDto;
    const providerStatus = pickPrimaryIssue(groupedReceipts.map((receipt) => receipt.providerStatus));
    const lastError = pickPrimaryIssue(groupedReceipts.map((receipt) => receipt.lastError));
    const latestTimestamp = findLatestReceiptTimestamp(groupedReceipts);
    const totalAttempts = groupedReceipts.reduce((sum, receipt) => sum + Math.max(0, receipt.attempts), 0);
    const maxAttempts = groupedReceipts.reduce((max, receipt) => Math.max(max, receipt.attempts), 0);

    const setupIssue = groupedReceipts.some((receipt) =>
      isProviderSetupIssue(receipt.providerStatus) || isProviderSetupIssue(receipt.lastError)
    );

    return {
      key,
      receipts: groupedReceipts,
      channel: first.channel,
      provider: first.provider,
      status: first.status,
      count: groupedReceipts.length,
      recipientLabel: getReceiptGroupRecipientLabel(first, groupedReceipts.length),
      providerStatus,
      lastError,
      showLastError: Boolean(
        lastError &&
        lastError !== providerStatus &&
        !(setupIssue && isProviderSetupIssue(lastError) && isProviderSetupIssue(providerStatus)),
      ),
      latestTimestamp,
      totalAttempts,
      maxAttempts,
      setupIssue,
    };
  });
}

export function deliveryAttemptLabel(group: Pick<
  OrderNotificationReceiptDisplayGroup,
  "status" | "count" | "maxAttempts" | "totalAttempts" | "setupIssue"
>): string {
  if (group.status === "skipped") {
    if (group.setupIssue) return "Paused";
    return group.maxAttempts > 1 ? `Stopped after ${group.maxAttempts} attempts` : "Not sent";
  }
  if (TERMINAL_DELIVERY_STATUSES.has(group.status)) {
    return humanize(group.status);
  }
  const attempts = group.count > 1 ? group.totalAttempts : group.maxAttempts;
  return `${attempts} attempt${attempts === 1 ? "" : "s"}`;
}

export function outboxAttemptLabel(outbox: Pick<OrderNotificationOutboxDto, "status" | "attempts">): string | null {
  if (TERMINAL_OUTBOX_STATUSES.has(outbox.status)) {
    return null;
  }
  if (outbox.status === "dead_lettered") {
    return "Retry stopped";
  }
  if (outbox.status === "failed" && outbox.attempts >= 8) {
    return "Needs attention";
  }
  return `${outbox.attempts} attempt${outbox.attempts === 1 ? "" : "s"}`;
}

function getReceiptGroupRecipientLabel(receipt: OrderNotificationReceiptDto, count: number): string {
  if (count <= 1) return receipt.recipientMasked ?? "No recipient";
  if (receipt.channel === "push") return `${count} admin devices`;
  return `${count} recipients`;
}

function findLatestReceiptTimestamp(receipts: OrderNotificationReceiptDto[]): string | number | null {
  let latest: string | number | null = null;
  let latestNumber = Number.NEGATIVE_INFINITY;
  for (const receipt of receipts) {
    const value =
      receipt.deliveredAt
      ?? receipt.acceptedAt
      ?? receipt.skippedAt
      ?? receipt.failedAt
      ?? receipt.lastAttemptAt
      ?? receipt.createdAt;
    const numeric = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numeric) && numeric > latestNumber) {
      latestNumber = numeric;
      latest = value;
    }
  }
  return latest;
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayGroupingIssueKey(value: string | null | undefined): string {
  if (!value) return "";
  if (isProviderSetupIssue(value)) return "provider_setup";
  return describeNotificationIssue(value) ?? "";
}

function pickPrimaryIssue(values: Array<string | null | undefined>): string | null {
  const firstBlocked = values.find((value) =>
    value?.toLowerCase().includes("provider_blocked_until_settings_save")
  );
  const firstValue = firstBlocked ?? values.find((value) => Boolean(value?.trim()));
  return describeNotificationIssue(firstValue);
}

function isProviderSetupIssue(value: string | null | undefined): boolean {
  const normalized = value?.toLowerCase() ?? "";
  return (
    normalized.includes("provider_blocked_until_settings_save") ||
    normalized.includes("provider sending is paused") ||
    normalized.includes("provider rejected") ||
    normalized.includes("setup failure") ||
    normalized.includes("notification setup") ||
    normalized.includes("credentials") ||
    normalized.includes("could not be decrypted") ||
    normalized.includes("api key") ||
    normalized.includes("token") ||
    normalized.includes("invalid_grant") ||
    normalized.includes("service account") ||
    normalized.includes("private key") ||
    normalized.includes("authorization required") ||
    normalized.includes("authentication failed") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    /\b(?:http|status|code|error)[^0-9]*(?:400|401|402|403|404|405|422)\b/.test(normalized) ||
    normalized.includes("sender id") ||
    normalized.includes("balance")
  );
}
