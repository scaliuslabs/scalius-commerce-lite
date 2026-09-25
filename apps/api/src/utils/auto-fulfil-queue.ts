// The fast path of automatic fulfilment (Wave B design §0 "Auto-fulfil").
//
// After an order's payment settles and that write has committed, the caller
// sends `order.auto_fulfil` so digital and gift-card lines are handed over in
// seconds. The settled-but-unfulfilled state itself is the durable outbox: the
// 15-minute sweep (`sweepAutoFulfilment`) picks up anything this send misses,
// so a failed send is logged and swallowed, never thrown into the settle path.
// The consumer (`queue-consumer.ts`) is idempotent, so extra sends are harmless,
// and an order without automatic lines is a cheap no-op there.
import type { OrderAutoFulfilQueueMessage } from "@scalius/core/modules/fulfilment";

/** The one queue method this needs (the `JOBS_QUEUE` binding satisfies it). */
export interface AutoFulfilQueue {
  send(message: OrderAutoFulfilQueueMessage): Promise<unknown>;
}

/**
 * Enqueue automatic fulfilment for one settled order. Returns whether the
 * message was accepted. Never throws. Logs carry the order id and the error
 * class only (no buyer data, no payloads).
 */
export async function enqueueOrderAutoFulfil(
  queue: AutoFulfilQueue | undefined,
  orderId: string,
  source: string,
): Promise<boolean> {
  if (!queue || !orderId) return false;
  const message: OrderAutoFulfilQueueMessage = { type: "order.auto_fulfil", orderId };
  try {
    await queue.send(message);
    return true;
  } catch (error: unknown) {
    console.warn(
      `[${source}] order.auto_fulfil enqueue failed for order ${orderId}; the scheduled sweep will retry:`,
      error instanceof Error ? error.name : "unknown",
    );
    return false;
  }
}
