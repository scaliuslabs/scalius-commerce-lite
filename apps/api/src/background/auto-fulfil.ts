// The fast path of automatic fulfilment (Wave B design §0 "Auto-fulfil").
//
// After an order's payment settles and that write has committed, its digital
// and gift-card lines are handed over right after the response. The
// settled-but-unfulfilled state itself is the durable outbox: the scheduled
// sweep (`sweepAutoFulfilment`) picks up anything this run misses, so a
// failure is logged and swallowed, never thrown into the settle path. The run
// is idempotent (the ledger's request keys), so an extra run is harmless and
// an order without automatic lines is a cheap no-op.
import type { Database } from "@scalius/database/client";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import { afterResponse, executionContextOf, type BackgroundCaller } from "./after-response";

/**
 * Hands one settled order's automatic lines over, then sends what that wrote:
 * its notifications (gift-card codes, downloads, a key-exhausted staff alert)
 * and its events.
 */
export async function runOrderAutoFulfil(db: Database, env: Env, ctx: ExecutionContext, orderId: string): Promise<void> {
  const [{ autoFulfilOrder }, { drainNotificationOutbox }, { flushEventsAfterWrite }] = await Promise.all([
    import("@scalius/core/modules/fulfilment"),
    import("./notifications"),
    import("../events/flush"),
  ]);
  try {
    await autoFulfilOrder(db, orderId, undefined, {
      credentialEncryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
    });
  } finally {
    await drainNotificationOutbox(db, env);
    await flushEventsAfterWrite(db, env, ctx);
  }
}

/** Runs `runOrderAutoFulfil` after the response. Never throws; logs carry the source and error class only. */
export async function autoFulfilAfterResponse(
  caller: BackgroundCaller & { env: Env },
  db: Database,
  orderId: string,
  source: string,
): Promise<void> {
  if (!orderId) return;
  await afterResponse(caller, `${source} automatic fulfilment`, () =>
    runOrderAutoFulfil(db, caller.env, executionContextOf(caller), orderId));
}
