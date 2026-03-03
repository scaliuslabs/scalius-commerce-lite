import type { DeliveryProviderType } from "@/db/schema";

/**
 * Standardized shipment status codes
 */
export enum ShipmentStatusCode {
  PENDING = "pending",
  PICKED_UP = "picked_up",
  IN_TRANSIT = "in_transit",
  DELIVERED = "delivered",
  FAILED = "failed",
  CANCELLED = "cancelled",
  RETURNED = "returned",
  UNKNOWN = "unknown",
}

/**
 * Map provider-specific statuses to our standardized status codes
 */
export function mapProviderStatus(
  providerType: DeliveryProviderType,
  status: string,
): string {
  switch (providerType) {
    case "pathao":
      return mapPathaoStatus(status);
    case "steadfast":
      return mapSteadfastStatus(status);
    default:
      return ShipmentStatusCode.UNKNOWN;
  }
}

/**
 * Map Pathao-specific status codes to standardized ones
 * Based on Pathao documentation
 */
function mapPathaoStatus(status: string): string {
  const lowercaseStatus = status.toLowerCase();

  console.log(
    `Mapping Pathao status: "${status}" (lowercase: "${lowercaseStatus}")`,
  );

  // Look for specific patterns that need special handling
  if (
    lowercaseStatus.includes("pickup cancelled") ||
    lowercaseStatus.includes("pickup_cancelled")
  ) {
    console.log(
      `Mapped Pathao status "${status}" to ${ShipmentStatusCode.CANCELLED}`,
    );
    return ShipmentStatusCode.CANCELLED;
  } else if (lowercaseStatus.includes("pending")) {
    return ShipmentStatusCode.PENDING;
  } else if (
    (lowercaseStatus.includes("pick") && !lowercaseStatus.includes("cancel")) ||
    lowercaseStatus.includes("accepted")
  ) {
    return ShipmentStatusCode.PICKED_UP;
  } else if (
    lowercaseStatus.includes("transit") ||
    lowercaseStatus.includes("processing")
  ) {
    return ShipmentStatusCode.IN_TRANSIT;
  } else if (lowercaseStatus.includes("delivered")) {
    return ShipmentStatusCode.DELIVERED;
  } else if (
    lowercaseStatus.includes("failed") ||
    lowercaseStatus.includes("unknown")
  ) {
    return ShipmentStatusCode.FAILED;
  } else if (lowercaseStatus.includes("cancel")) {
    return ShipmentStatusCode.CANCELLED;
  } else if (lowercaseStatus.includes("return")) {
    return ShipmentStatusCode.RETURNED;
  } else {
    console.log(
      `Unmapped Pathao status: "${status}" - defaulting to ${ShipmentStatusCode.UNKNOWN}`,
    );
    return ShipmentStatusCode.UNKNOWN;
  }
}

/**
 * Map Steadfast-specific status codes to standardized ones
 * Based on Steadfast documentation
 */
function mapSteadfastStatus(status: string): string {
  const lowercaseStatus = status.toLowerCase();

  console.log(
    `Mapping Steadfast status: "${status}" (lowercase: "${lowercaseStatus}")`,
  );

  if (lowercaseStatus.includes("pending") || lowercaseStatus === "in_review") {
    return ShipmentStatusCode.PENDING;
  } else if (lowercaseStatus.includes("delivered")) {
    return ShipmentStatusCode.DELIVERED;
  } else if (lowercaseStatus.includes("partial_delivered")) {
    return ShipmentStatusCode.DELIVERED;
  } else if (lowercaseStatus.includes("cancelled")) {
    return ShipmentStatusCode.CANCELLED;
  } else if (lowercaseStatus === "unknown") {
    console.log(
      `Mapping Steadfast "unknown" status to ${ShipmentStatusCode.CANCELLED}`,
    );
    return ShipmentStatusCode.CANCELLED;
  } else if (
    lowercaseStatus.includes("in_transit") ||
    lowercaseStatus.includes("transit")
  ) {
    return ShipmentStatusCode.IN_TRANSIT;
  } else if (lowercaseStatus.includes("pick")) {
    return ShipmentStatusCode.PICKED_UP;
  } else if (lowercaseStatus.includes("return")) {
    return ShipmentStatusCode.RETURNED;
  } else if (lowercaseStatus.includes("fail")) {
    return ShipmentStatusCode.FAILED;
  } else {
    console.log(
      `Unmapped Steadfast status: "${status}" - defaulting to ${ShipmentStatusCode.UNKNOWN}`,
    );
    return ShipmentStatusCode.UNKNOWN;
  }
}
