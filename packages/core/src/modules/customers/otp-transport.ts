// src/modules/customers/otp-transport.ts
// The OTP delivery reference the API sends after the response
// (apps/api/src/background/otp.ts). It carries opaque challenge/delivery
// references only: the recipient, the name, the method and the expiry are
// read from the challenge row and the code is derived at send time, so none
// of them is ever handed around in memory or logged.
import type { CustomerAuthOtpChannel } from "@scalius/shared/customer-auth-policy";

export interface OtpDelivery {
  purpose: string;
  challengeKey: string;
  deliveryKey: string;
  /** Only for the receipt of a challenge that cannot be read any more. */
  channel: CustomerAuthOtpChannel;
}

/** One reference-only OTP delivery for a challenge on one channel. */
export function buildOtpDelivery(input: {
  channel: CustomerAuthOtpChannel;
  purpose: string;
  challengeKey: string;
  deliveryKey: string;
}): OtpDelivery {
  return {
    purpose: input.purpose,
    challengeKey: input.challengeKey,
    deliveryKey: input.deliveryKey,
    channel: input.channel,
  };
}
