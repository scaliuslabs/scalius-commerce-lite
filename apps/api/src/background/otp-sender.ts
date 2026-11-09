// Sends an OTP after the response. Small on purpose: routes import it
// statically, and the delivery code (background/otp.ts) loads only then.
import type { Database } from "@scalius/database/client";
import type { OtpDelivery } from "@scalius/core/modules/customers";
import { isMarketSubfolder, STOREFRONT_PRESENCE_HEADER } from "@scalius/shared/markets";
import { afterResponse, type BackgroundCaller } from "./after-response";

/** The code goes out right after the response with short inline retries. Never throws. */
export async function sendAuthOtp(
  caller: BackgroundCaller & { env: Env; req?: { header(name: string): string | undefined } },
  db: Database,
  delivery: OtpDelivery,
): Promise<void> {
  // The page the buyer asked from (`/bn/`), through the storefront's proxy: the code speaks its language.
  const presence = caller.req?.header(STOREFRONT_PRESENCE_HEADER)?.trim().toLowerCase();
  const sent = isMarketSubfolder(presence) ? { ...delivery, presence } : delivery;
  await afterResponse(caller, "OTP delivery", async () => {
    const { deliverAuthOtpWithRetries } = await import("./otp");
    await deliverAuthOtpWithRetries(sent, db, caller.env);
  });
}
