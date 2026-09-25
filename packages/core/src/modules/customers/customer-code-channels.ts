// Where one-time codes go. Every code (sign-in, account phone, Track your
// order, payment recovery) uses a channel the merchant chose in Settings →
// Customer accounts. A chosen channel whose provider can't send fails closed
// with a buyer-facing message; no code ever silently moves to another channel.
import type { Database } from "@scalius/database/client";
import { AppError, ServiceUnavailableError } from "@scalius/core/errors";
import {
  channelRequestMethod,
  orderCodeChannels,
  resolveSignInChannel,
  type CustomerAuthOtpChannel,
  type CustomerIdentitySettings,
  type OrderContactForCodes,
} from "@scalius/shared/customer-auth-policy";
import type { EmailRuntimeContext } from "../../integrations/email";
import { isCustomerAuthChannelReady } from "../settings/checkout-readiness";
import { customerAuthDocument } from "../settings/documents";
import { maskContact } from "./customer-identity";

const CHANNEL_UNAVAILABLE: Record<CustomerAuthOtpChannel, string> = {
  email: "Email codes aren't available right now.",
  sms: "Text message codes aren't available right now.",
  whatsapp: "WhatsApp codes aren't available right now.",
};

/** Throws the channel's own "not available" message when its provider can't send. */
export async function assertCustomerChannelReady(
  db: Database,
  channel: CustomerAuthOtpChannel,
  input: { emailEnv?: EmailRuntimeContext["env"]; credentialEncryptionKey?: string },
): Promise<void> {
  const ready = await isCustomerAuthChannelReady(db, channel, {
    encryptionKey: input.credentialEncryptionKey,
    runtimeEnv: input.emailEnv,
  });
  if (!ready) throw new ServiceUnavailableError(CHANNEL_UNAVAILABLE[channel]);
}

/**
 * The phone code channel for the signed-in account's own phone: the first
 * phone channel the merchant chose, when it can send. Null otherwise.
 */
export async function phoneCodeChannel(
  db: Database,
  identity: CustomerIdentitySettings,
  credentialEncryptionKey: string | undefined,
): Promise<CustomerAuthOtpChannel | null> {
  const channel = resolveSignInChannel(identity.channels, "phone");
  if (!channel) return null;
  const ready = await isCustomerAuthChannelReady(db, channel, { encryptionKey: credentialEncryptionKey });
  return ready ? channel : null;
}

/** No chosen channel can reach a contact saved on this order. */
export class NoOrderCodeChannelError extends AppError {
  constructor() {
    super(409, "NO_CODE_CHANNEL", "This order has no contact we can send a code to.");
  }
}

/** The chosen channel's provider can't send right now (fail closed, no fallback). */
export class OrderCodeChannelUnavailableError extends AppError {
  constructor(channel: CustomerAuthOtpChannel) {
    super(409, "CODE_CHANNEL_UNAVAILABLE", CHANNEL_UNAVAILABLE[channel]);
  }
}

export interface OrderCodeOption {
  channel: CustomerAuthOtpChannel;
  /** Masked contact the code would go to ("01•••••678", "b•••@example.com"). */
  destination: string;
}

export async function readCustomerIdentity(db: Database): Promise<CustomerIdentitySettings> {
  return await customerAuthDocument.read(db);
}

/** The ways a code for this order can be sent, masked, in the merchant's order. */
export function listOrderCodeOptions(
  identity: CustomerIdentitySettings,
  order: OrderContactForCodes,
): OrderCodeOption[] {
  return orderCodeChannels(identity, order).map(({ channel, target }) => ({
    channel,
    destination: maskContact(channelRequestMethod(channel), target),
  }));
}

/**
 * The channel and contact a code for this order uses: the requested channel
 * when the merchant chose it and the order has that contact, else the first
 * such channel. The code always goes to a contact saved on the order.
 */
export async function chooseOrderCodeChannel(
  db: Database,
  order: OrderContactForCodes,
  input: { channel?: CustomerAuthOtpChannel; emailEnv?: EmailRuntimeContext["env"]; credentialEncryptionKey?: string },
): Promise<{ channel: CustomerAuthOtpChannel; method: "email" | "phone"; target: string; destination: string }> {
  const identity = await readCustomerIdentity(db);
  const options = orderCodeChannels(identity, order);
  const chosen = options.find((option) => option.channel === input.channel) ?? options[0];
  if (!chosen) throw new NoOrderCodeChannelError();
  const ready = await isCustomerAuthChannelReady(db, chosen.channel, {
    encryptionKey: input.credentialEncryptionKey,
    runtimeEnv: input.emailEnv,
  });
  if (!ready) throw new OrderCodeChannelUnavailableError(chosen.channel);
  const method = channelRequestMethod(chosen.channel);
  return { channel: chosen.channel, method, target: chosen.target, destination: maskContact(method, chosen.target) };
}
