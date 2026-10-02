/**
 * OTP handoff to the jobs queue, with a direct-delivery fallback.
 *
 * A sign-in code is the one job a person is staring at a screen for. If the
 * queue refuses it (the binding is down, or Workers Free's 10,000 daily
 * Queues operations are spent) the code is delivered from this request's
 * `waitUntil` instead of failing the sign-in. The same function the consumer
 * runs delivers it, and the delivery receipt in D1 is claimed exactly once, so
 * a message the queue did take after all finds the receipt accepted and does
 * nothing. Without an execution context there is no way to keep the work alive
 * after the response, so the original error is thrown for the route to handle.
 */
import type { Database } from "@scalius/database/client";
import type { AuthOtpQueueMessage } from "../queue-consumer";
import { getOptionalExecutionContext, type WaitUntilExecutionContext } from "./execution-context";

export type OtpHandoff = "queued" | "direct";

export interface OtpHandoffContext {
  env: Env;
  get(key: "db"): Database;
  executionCtx?: WaitUntilExecutionContext;
}

export async function enqueueAuthOtp(c: OtpHandoffContext, payload: AuthOtpQueueMessage): Promise<OtpHandoff> {
  try {
    await c.env.JOBS_QUEUE.send(payload);
    return "queued";
  } catch (queueError) {
    const executionCtx = getOptionalExecutionContext(c);
    if (!executionCtx) throw queueError;
    console.warn("[OTP] Queue handoff failed; delivering directly", {
      error: queueError instanceof Error ? queueError.name : typeof queueError,
    });
    const db = c.get("db");
    executionCtx.waitUntil((async () => {
      try {
        const { deliverAuthOtpDirect } = await import("../queue-consumer");
        await deliverAuthOtpDirect(payload, db, c.env);
      } catch (error) {
        // Masked: a delivery error can carry a recipient or provider text.
        console.error("[OTP] Direct delivery failed", { error: error instanceof Error ? error.name : typeof error });
      }
    })());
    return "direct";
  }
}
