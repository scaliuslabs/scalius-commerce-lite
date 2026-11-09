import { unixToDate } from "@scalius/shared/timestamps";
import { formatDateTime, useMessages } from "~/i18n";
import { shipmentMetadataMessages } from "~/i18n/shipment-metadata";
import { cn } from "@scalius/shared/utils";

interface ShipmentMetadataDisplayProps {
  metadata: Record<string, unknown> | string | null;
  className?: string;
}

type MetadataLabel = keyof (typeof shipmentMetadataMessages)["en"];

// Fields to show prominently (in order), named in the dashboard's language.
const DISPLAY_FIELDS: Record<string, MetadataLabel> = {
  consignmentId: "consignmentId",
  consignment_id: "consignmentId",
  trackingId: "trackingId",
  tracking_id: "trackingId",
  tracking_code: "trackingCode",
  merchantOrderId: "merchantOrderId",
  merchant_order_id: "merchantOrderId",
  deliveryFee: "deliveryFee",
  delivery_fee: "deliveryFee",
  collectedAmount: "collectedAmount",
  collected_amount: "collectedAmount",
  codAmount: "codAmount",
  cod_amount: "codAmount",
  lastReason: "reason",
  reason: "reason",
  trackingMessage: "trackingMessage",
  tracking_message: "trackingMessage",
  courierName: "courier",
  providerType: "provider",
};

// Fields to hide (internal/noisy)
const HIDDEN_FIELDS = new Set([
  "lastWebhookPayload",
  "lastWebhookAt",
  "rawStatus",
  "id",
  "created_at",
  "updated_at",
  "metadata",
]);

/**
 * Component to display shipment metadata in a clean, structured way.
 * Hides raw webhook payloads and internal fields, shows only useful info.
 */
export function ShipmentMetadataDisplay({ metadata, className }: ShipmentMetadataDisplayProps) {
  const t = useMessages(shipmentMetadataMessages);
  let parsed = metadata;

  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return <p className={cn("text-body text-muted-foreground", className)}>{t("unreadable")}</p>;
    }
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  // Collect displayable entries
  const entries: Array<{ label: string; value: string }> = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (HIDDEN_FIELDS.has(key)) continue;
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") continue; // skip nested objects

    // A field the courier adds that Scalius doesn't know keeps the courier's own name.
    const known = DISPLAY_FIELDS[key];
    const label = known ? t(known) : formatKey(key);
    entries.push({ label, value: String(value) });
  }

  // Deduplicate by label (e.g., both consignmentId and consignment_id)
  const seen = new Set<string>();
  const unique = entries.filter((e) => {
    if (seen.has(e.label)) return false;
    seen.add(e.label);
    return true;
  });

  if (unique.length === 0) {
    return null;
  }

  // Show last webhook time if available
  const lastWebhookAt = unixToDate((parsed.lastWebhookAt as string | number | undefined) ?? null);

  return (
    <dl className={cn("space-y-1 text-body", className)}>
      {unique.map(({ label, value }) => (
        <div key={label} className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-end font-medium">{value}</dd>
        </div>
      ))}
      {lastWebhookAt && Number.isFinite(lastWebhookAt.getTime()) && (
        <div className="flex justify-between gap-4 border-t pt-1">
          <dt className="text-muted-foreground">{t("lastUpdate")}</dt>
          <dd className="text-muted-foreground">{formatDateTime(lastWebhookAt, { dateStyle: "medium", timeStyle: "short" })}</dd>
        </div>
      )}
    </dl>
  );
}

function formatKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
