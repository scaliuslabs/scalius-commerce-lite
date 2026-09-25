// src/modules/customers/otp-transport.ts
// The OTP queue message. The queue consumer in apps/api/src/queue-consumer.ts
// dispatches on `method` + `channel`. Payloads carry opaque challenge/delivery
// references only: provider secrets, raw codes, recipients and names are
// resolved at send time and must never be serialized into queues.
import {
  channelRequestMethod,
  channelToAllowedMethod,
  type CustomerAuthOtpChannel,
} from "@scalius/shared/customer-auth-policy";

export interface OtpQueuePayload {
  type: "auth.send_otp";
  challengeKey: string;
  deliveryKey: string;
  purpose?: string;
  otpExpiresAt?: number;
  method: "email" | "phone";
  allowedMethod: string;
  channel?: CustomerAuthOtpChannel;
  /** Legacy pre-reference payloads only. New OTP queue payloads must omit this. */
  identifier?: string;
  /** Legacy pre-reference payloads only. New OTP queue payloads must omit this. */
  code?: string;
  /** Legacy pre-reference payloads only. New OTP queue payloads must omit this. */
  name?: string;
}

/** One reference-only OTP message for a challenge on one channel. */
export function buildOtpQueuePayload(input: {
  channel: CustomerAuthOtpChannel;
  purpose: string;
  challengeKey: string;
  deliveryKey: string;
  otpExpiresAt: number;
}): OtpQueuePayload {
  return {
    type: "auth.send_otp",
    challengeKey: input.challengeKey,
    deliveryKey: input.deliveryKey,
    purpose: input.purpose,
    otpExpiresAt: input.otpExpiresAt,
    method: channelRequestMethod(input.channel),
    allowedMethod: channelToAllowedMethod(input.channel),
    channel: input.channel,
  };
}
