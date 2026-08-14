type ShipmentActionProjection = {
  status?: string | null;
  providerId?: string | null;
  providerType?: string | null;
};

const DELETABLE_SHIPMENT_STATUSES = new Set(["failed", "cancelled"]);

export function canDeleteShipment(shipment: ShipmentActionProjection): boolean {
  return DELETABLE_SHIPMENT_STATUSES.has(shipment.status ?? "");
}

export function canRefreshShipment(shipment: ShipmentActionProjection): boolean {
  return Boolean(shipment.providerId) && shipment.providerType !== "manual";
}
