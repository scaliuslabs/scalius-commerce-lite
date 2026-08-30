import { readAdminOrderCreateRequestMismatch } from "../../../lib/admin-api-error";

export type ManualOrderCreateRecoveryPlan =
  | { action: "retry-with-new-key" }
  | { action: "open-existing"; orderId: string }
  | { action: "wait" }
  | { action: "surface-error" };

export function planManualOrderCreateRecovery(
  error: unknown,
  replacedRequestKey: boolean,
): ManualOrderCreateRecoveryPlan {
  const mismatch = readAdminOrderCreateRequestMismatch(error);
  if (!mismatch) return { action: "surface-error" };
  if (mismatch.state === "committed") {
    return { action: "open-existing", orderId: mismatch.orderId };
  }
  if (mismatch.state === "processing") return { action: "wait" };
  if (!replacedRequestKey && mismatch.canRetryWithNewKey) {
    return { action: "retry-with-new-key" };
  }
  return { action: "surface-error" };
}

export type ManualOrderCreateExecutionResult<TOrder> =
  | { outcome: "created"; order: TOrder; requestKey: string }
  | { outcome: "open-existing"; orderId: string; requestKey: string }
  | { outcome: "wait"; requestKey: string }
  | { outcome: "error"; error: unknown; requestKey: string };

export async function executeManualOrderCreateWithRecovery<TOrder>(options: {
  requestKey: string;
  submit: (requestKey: string) => Promise<TOrder>;
  replaceRequestKey: (failedRequestKey: string) => string;
}): Promise<ManualOrderCreateExecutionResult<TOrder>> {
  let requestKey = options.requestKey;
  let replacedRequestKey = false;

  for (;;) {
    try {
      return {
        outcome: "created",
        order: await options.submit(requestKey),
        requestKey,
      };
    } catch (error) {
      const recovery = planManualOrderCreateRecovery(error, replacedRequestKey);
      if (recovery.action === "retry-with-new-key") {
        requestKey = options.replaceRequestKey(requestKey);
        replacedRequestKey = true;
        continue;
      }
      if (recovery.action === "open-existing") {
        return {
          outcome: "open-existing",
          orderId: recovery.orderId,
          requestKey,
        };
      }
      if (recovery.action === "wait") {
        return { outcome: "wait", requestKey };
      }
      return { outcome: "error", error, requestKey };
    }
  }
}
