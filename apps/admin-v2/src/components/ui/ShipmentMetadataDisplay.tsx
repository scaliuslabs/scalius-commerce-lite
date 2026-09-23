import { formatDate } from "@scalius/shared/timestamps";
import { cn } from "@scalius/shared/utils";

interface ShipmentMetadataDisplayProps {
  metadata: Record<string, unknown> | string | null;
  className?: string;
}

// Fields to show prominently (in order)
const DISPLAY_FIELDS: Record<string, string> = {
  consignmentId: "Consignment ID",
  consignment_id: "Consignment ID",
  trackingId: "Tracking ID",
  tracking_id: "Tracking ID",
  tracking_code: "Tracking Code",
  merchantOrderId: "Merchant Order ID",
  merchant_order_id: "Merchant Order ID",
  deliveryFee: "Delivery Fee",
  delivery_fee: "Delivery Fee",
  collectedAmount: "Collected Amount",
  collected_amount: "Collected Amount",
  codAmount: "COD Amount",
  cod_amount: "COD Amount",
  lastReason: "Reason",
  reason: "Reason",
  trackingMessage: "Tracking Message",
  tracking_message: "Tracking Message",
  courierName: "Courier",
  providerType: "Provider",
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
  let parsed = metadata;

  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata);
    } catch {
      return <p className={cn("text-body text-muted-foreground", className)}>Unable to parse metadata</p>;
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

    const label = DISPLAY_FIELDS[key] || formatKey(key);
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
  const lastWebhookAt = parsed.lastWebhookAt as string | number | undefined;

  return (
    <dl className={cn("space-y-1 text-body", className)}>
      {unique.map(({ label, value }) => (
        <div key={label} className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right font-medium">{value}</dd>
        </div>
      ))}
      {lastWebhookAt && (
        <div className="flex justify-between gap-4 border-t pt-1">
          <dt className="text-muted-foreground">Last update</dt>
          <dd className="text-muted-foreground">{formatDate(lastWebhookAt)}</dd>
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
