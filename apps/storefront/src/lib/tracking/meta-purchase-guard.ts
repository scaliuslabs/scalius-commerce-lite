import { createMetaEventId } from "./meta-event-id";

const PURCHASE_SENT_KEY_PREFIX = "scalius_meta_purchase_sent:";

interface PurchaseTrackingClaim {
  shouldSend: boolean;
  eventId: string;
}

function getStorage(): Storage | null {
  try {
    return window.localStorage ?? window.sessionStorage ?? null;
  } catch {
    try {
      return window.sessionStorage ?? null;
    } catch {
      return null;
    }
  }
}

export function createPurchaseEventId(orderId: string): string {
  return createMetaEventId("Purchase", orderId);
}

export function claimMetaPurchaseTracking(orderId: string): PurchaseTrackingClaim {
  const eventId = createPurchaseEventId(orderId);
  const storage = getStorage();
  if (!storage) {
    return { shouldSend: true, eventId };
  }

  const key = `${PURCHASE_SENT_KEY_PREFIX}${orderId}`;
  if (storage.getItem(key)) {
    return { shouldSend: false, eventId };
  }

  storage.setItem(
    key,
    JSON.stringify({
      eventId,
      attemptedAt: Date.now(),
    }),
  );

  return { shouldSend: true, eventId };
}
