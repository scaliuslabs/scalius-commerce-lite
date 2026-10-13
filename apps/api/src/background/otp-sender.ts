// Sends an OTP after the response. Small on purpose: routes import it
// statically, and the delivery code (background/otp.ts) loads only then.
import type { Database } from "@scalius/database/client";
import type { OtpDelivery } from "@scalius/core/modules/customers";
import { afterResponse, type BackgroundCaller } from "./after-response";

/** The code goes out right after the response with short inline retries. Never throws. */
export async function sendAuthOtp(caller: BackgroundCaller & { env: Env }, db: Database, delivery: OtpDelivery): Promise<void> {
  await afterResponse(caller, "OTP delivery", async () => {
    const { deliverAuthOtpWithRetries } = await import("./otp");
    await deliverAuthOtpWithRetries(delivery, db, caller.env);
  });
}
