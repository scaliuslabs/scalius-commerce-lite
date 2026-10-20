// OTP delivery. A sign-in code is the one background job a person is staring
// at a screen for, so it is sent right after the response (`waitUntil`) with
// short inline retries: a code expires in five minutes, and the buyer can ask
// for a new one. The delivery carries opaque challenge/delivery references
// only; the target, the name, the channel and the expiry are read from the
// D1 challenge row and the code is derived at send time. The delivery receipt
// (`auth_otp_delivery_receipts`) is claimed once per attempt, so a code is
// sent at most once per accepted attempt; its terminal states (`accepted`,
// `skipped`, or `failed` after the last inline attempt) are what the
// dashboard's delivery log shows.

import type { getDb } from "@scalius/database/client";
import {
  customerAuthOtpChallenges,
  orderPaymentRecoveryChallenges,
  orders,
} from "@scalius/database/schema";
import { and, eq } from "drizzle-orm";
import {
  composeAuthOtpMessage,
  readStoreIdentity,
  getNotificationProviderBlock,
  isNotificationProviderBreakerFailure,
  markNotificationProviderBlocked,
} from "@scalius/core/modules/notifications";
import { sendEmail } from "@scalius/core/integrations/email";
import { getActiveSmsProvider } from "@scalius/core/integrations/sms";
import { resolveWhatsAppSender } from "@scalius/core/integrations/whatsapp-sender";
import {
  deriveCustomerAuthOtpDeliveryCode,
  claimAuthOtpDeliveryReceipt,
  createAuthOtpDeliveryTarget,
  createAuthOtpProviderClientReference,
  getAuthOtpDeliveryRetryDelaySeconds,
  markAuthOtpDeliveryReceiptAccepted,
  markAuthOtpDeliveryReceiptFailed,
  markAuthOtpDeliveryReceiptSkipped,
  type AuthOtpDeliveryChannel,
  type AuthOtpDeliveryReceiptResult,
  type OtpDelivery,
} from "@scalius/core/modules/customers";
import { readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";
import { detachedAppProviders } from "../plugins/providers/app-providers";
import { getCredentialEncryptionKey } from "../utils/encryption-key";

/** Attempts one request makes: the first at once, then after each receipt's short backoff (2 s, 6 s). */
export const OTP_INLINE_ATTEMPTS = 3;

export async function deliverAuthOtpWithRetries(
  delivery: OtpDelivery,
  db: ReturnType<typeof getDb>,
  env: Env,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  for (let attempt = 1; attempt <= OTP_INLINE_ATTEMPTS; attempt += 1) {
    const outcome = await deliverAuthOtp(delivery, db, env);
    if (outcome.status === "done" || outcome.status === "busy" || attempt === OTP_INLINE_ATTEMPTS) return;
    await wait(outcome.retryAfterSeconds * 1_000);
  }
}

type AuthOtpAttemptOutcome =
  | { status: "done" }
  | { status: "busy" }
  | { status: "retry"; retryAfterSeconds: number };

async function markAuthOtpDeliveryReceiptAcceptedWithRetries(
  db: ReturnType<typeof getDb>,
  receipt: Parameters<typeof markAuthOtpDeliveryReceiptAccepted>[1],
  result: AuthOtpDeliveryReceiptResult,
): Promise<void> {
  await retryAuthOtpReceiptWrite(() => markAuthOtpDeliveryReceiptAccepted(db, receipt, result));
}

async function markAuthOtpDeliveryReceiptSkippedWithRetries(
  db: ReturnType<typeof getDb>,
  receipt: Parameters<typeof markAuthOtpDeliveryReceiptSkipped>[1],
  reason: string,
  result: AuthOtpDeliveryReceiptResult,
): Promise<void> {
  await retryAuthOtpReceiptWrite(() => markAuthOtpDeliveryReceiptSkipped(db, receipt, reason, result));
}

async function retryAuthOtpReceiptWrite<T>(
  operation: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await sleep(50 * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What one send needs, read from the challenge row (never from the delivery reference). */
type ResolvedAuthOtp = {
  purpose: string;
  challengeKey: string;
  deliveryKey: string;
  method: "email" | "phone";
  channel: AuthOtpDeliveryChannel;
  identifier: string;
  name: string;
  /** Order codes name their order ("view order #1057"). */
  orderNumber: number | null;
  otpExpiresAt: number | null;
};

type AuthOtpDeliveryChallengeRow = {
  deliveryTargetEncrypted: string | null;
  deliveryNameEncrypted: string | null;
  method: "email" | "phone";
  channel: AuthOtpDeliveryChannel;
  expiresAt: number;
  orderNumber?: number | null;
};

async function resolveAuthOtp(
  delivery: OtpDelivery,
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<{ resolved: ResolvedAuthOtp; resolutionError?: AuthOtpDeliveryError }> {
  const unresolved: ResolvedAuthOtp = {
    purpose: delivery.purpose,
    challengeKey: delivery.challengeKey,
    deliveryKey: delivery.deliveryKey,
    method: delivery.channel === "email" ? "email" : "phone",
    channel: delivery.channel,
    identifier: `unresolved:${delivery.deliveryKey}`,
    name: "",
    orderNumber: null,
    otpExpiresAt: null,
  };

  const row = await selectAuthOtpDeliveryChallengeRow(db, delivery);
  if (!row) {
    return {
      resolved: unresolved,
      resolutionError: createAuthOtpDeliveryError(
        "OTP delivery target could not be found",
        { provider: delivery.channel, providerStatus: "missing_delivery_target" },
        { terminal: true },
      ),
    };
  }

  const fromRow = { ...unresolved, method: row.method, channel: row.channel, otpExpiresAt: row.expiresAt };
  const credentialKey = getCredentialEncryptionKey(env as unknown as Record<string, unknown>);
  const target = await readStoredCredentialStrict(row.deliveryTargetEncrypted, credentialKey, "OTP delivery target");
  if (target.error || !target.value.trim()) {
    return {
      resolved: fromRow,
      resolutionError: createAuthOtpDeliveryError(
        target.error ?? "OTP delivery target is missing",
        {
          provider: row.channel,
          providerStatus: target.error ? "delivery_target_decrypt_failed" : "missing_delivery_target",
        },
        { terminal: true },
      ),
    };
  }

  const name = await readStoredCredentialStrict(row.deliveryNameEncrypted, credentialKey, "OTP delivery name");
  return {
    resolved: {
      ...fromRow,
      identifier: target.value.trim(),
      // A missing or unreadable name only drops the name from the greeting.
      name: name.error ? "" : name.value.trim(),
      orderNumber: row.orderNumber ?? null,
    },
  };
}

async function selectAuthOtpDeliveryChallengeRow(
  db: ReturnType<typeof getDb>,
  input: { purpose: string; challengeKey: string; deliveryKey: string },
): Promise<AuthOtpDeliveryChallengeRow | null> {
  // Track-order lookups share the payment-recovery challenge table.
  if (input.purpose === "order_payment_recovery" || input.purpose === "order_lookup") {
    const row = await db.select({
      deliveryTargetEncrypted: orderPaymentRecoveryChallenges.deliveryTargetEncrypted,
      deliveryNameEncrypted: orderPaymentRecoveryChallenges.deliveryNameEncrypted,
      method: orderPaymentRecoveryChallenges.method,
      channel: orderPaymentRecoveryChallenges.channel,
      expiresAt: orderPaymentRecoveryChallenges.expiresAt,
      orderNumber: orders.orderNumber,
    })
      .from(orderPaymentRecoveryChallenges)
      .leftJoin(orders, eq(orders.id, orderPaymentRecoveryChallenges.orderId))
      .where(and(
        eq(orderPaymentRecoveryChallenges.challengeKey, input.challengeKey),
        eq(orderPaymentRecoveryChallenges.deliveryKey, input.deliveryKey),
      ))
      .get();
    return row ?? null;
  }

  const row = await db.select({
    deliveryTargetEncrypted: customerAuthOtpChallenges.deliveryTargetEncrypted,
    deliveryNameEncrypted: customerAuthOtpChallenges.deliveryNameEncrypted,
    method: customerAuthOtpChallenges.method,
    channel: customerAuthOtpChallenges.channel,
    expiresAt: customerAuthOtpChallenges.expiresAt,
  })
    .from(customerAuthOtpChallenges)
    .where(and(
      eq(customerAuthOtpChallenges.otpKey, input.challengeKey),
      eq(customerAuthOtpChallenges.deliveryKey, input.deliveryKey),
    ))
    .get();
  return row ?? null;
}

/** A receipt another attempt holds, or one waiting longer than an inline retry would: leave it. */
const OTP_INLINE_MAX_WAIT_SECONDS = 10;

/**
 * One delivery attempt: claim the receipt, resolve the target, send, record.
 * Returns whether another inline attempt is worth making and when.
 */
export async function deliverAuthOtp(
  delivery: OtpDelivery,
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<AuthOtpAttemptOutcome> {
  const { resolved, resolutionError } = await resolveAuthOtp(delivery, db, env);
  const target = await createAuthOtpDeliveryTarget({
    deliveryKey: resolved.deliveryKey,
    purpose: resolved.purpose,
    method: resolved.method,
    channel: resolved.channel,
    provider: resolved.channel,
    identifier: resolved.identifier,
    otpExpiresAt: resolved.otpExpiresAt,
  });
  const claim = await claimAuthOtpDeliveryReceipt(db, target);

  if (!claim.claimed) {
    if (claim.reason === "busy" && (claim.retryAfterSeconds ?? Infinity) <= OTP_INLINE_MAX_WAIT_SECONDS) {
      return { status: "retry", retryAfterSeconds: claim.retryAfterSeconds! };
    }
    console.log(`[otp] Skipped delivery ${target.deliveryKey}: ${claim.reason}`);
    return claim.reason === "busy" ? { status: "busy" } : { status: "done" };
  }

  try {
    if (resolutionError) throw resolutionError;

    if (target.otpExpiresAt && target.otpExpiresAt <= Math.floor(Date.now() / 1000)) {
      await markAuthOtpDeliveryReceiptSkipped(db, claim.receipt, "otp_expired", {
        provider: target.provider,
        providerStatus: "otp_expired",
      });
      console.log(`[otp] Skipped expired delivery ${target.deliveryKey}`);
      return { status: "done" };
    }

    const code = await deriveCustomerAuthOtpDeliveryCode({
      otpKey: resolved.challengeKey,
      deliveryKey: resolved.deliveryKey,
      encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
    });
    const result = await sendAuthOtpByChannel(resolved, code, target, db, env);
    await markAuthOtpDeliveryReceiptAcceptedWithRetries(db, claim.receipt, result).catch((markError: unknown) => {
      // The provider took the code but the receipt could not say so: it stays
      // claimed until its lease ends, so no further attempt sends it again.
      console.error(`[otp] Delivery ${target.deliveryKey} sent, receipt not marked:`, markError instanceof Error ? markError.name : "error");
    });
    return { status: "done" };
  } catch (error) {
    const failureResult = getAuthOtpDeliveryFailureResult(error);
    if (isAuthOtpTerminalDeliveryFailure(error, failureResult)) {
      const reason = getAuthOtpTerminalDeliveryReason(error, failureResult);
      await blockAuthOtpProviderForMerchantActionableFailure(db, target, error, failureResult);
      await markAuthOtpDeliveryReceiptSkippedWithRetries(
        db,
        claim.receipt,
        reason,
        {
          provider: failureResult.provider ?? target.provider,
          providerMessageId: failureResult.providerMessageId,
          providerStatus: failureResult.providerStatus ?? reason,
          rawResponse: failureResult.rawResponse,
        },
      );
      console.warn(`[otp] Skipped delivery ${target.deliveryKey}: ${redactAuthOtpLogText(reason)}`);
      return { status: "done" };
    }

    await markAuthOtpDeliveryReceiptFailed(db, claim.receipt, error, failureResult).catch((markError: unknown) => {
      console.error("[otp] Failed to mark delivery receipt failure:", markError instanceof Error ? markError.name : "error");
    });
    return { status: "retry", retryAfterSeconds: getAuthOtpDeliveryRetryDelaySeconds(claim.receipt.attempts) };
  }
}

async function sendAuthOtpByChannel(
  payload: ResolvedAuthOtp,
  code: string,
  target: { deliveryKey: string; channel: AuthOtpDeliveryChannel; identifierHash: string },
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<AuthOtpDeliveryReceiptResult> {
  if (payload.channel === "whatsapp") {
    return sendAuthOtpWhatsApp(payload, code, target, db, env);
  }

  const message = composeAuthOtpMessage(await readOtpStoreIdentity(db), {
    purpose: payload.purpose,
    code,
    name: payload.name,
    orderNumber: payload.orderNumber,
  });
  return payload.channel === "email"
    ? sendAuthOtpEmail(payload, message, target, db, env)
    : sendAuthOtpSms(payload, message, target, db, env);
}

/**
 * The store name and language the code is sent in. A code expires in minutes,
 * so a failed settings read sends it unbranded in English instead of waiting.
 */
async function readOtpStoreIdentity(db: ReturnType<typeof getDb>) {
  try {
    return await readStoreIdentity(db);
  } catch (error) {
    console.warn(
      "[otp] Store identity unavailable; sending unbranded:",
      error instanceof Error ? error.name : "error",
    );
    return { name: null, logoUrl: null, language: "en" as const };
  }
}

type AuthOtpMessage = ReturnType<typeof composeAuthOtpMessage>;

async function sendAuthOtpEmail(
  payload: ResolvedAuthOtp,
  message: AuthOtpMessage,
  target: { deliveryKey: string; identifierHash: string },
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<AuthOtpDeliveryReceiptResult> {
  const block = await getNotificationProviderBlock(db, {
    channel: "email",
    provider: "email",
  });
  if (block) {
    throw createAuthOtpDeliveryError(
      buildAuthOtpProviderBlockedReason(block.reason),
      {
        provider: "email",
        providerStatus: "provider_blocked_until_settings_save",
        rawResponse: block.reason,
      },
      { terminal: true },
    );
  }

  const encryptionKey = getCredentialEncryptionKey(env as unknown as Record<string, unknown>);
  const result = await sendEmail({
    to: payload.identifier,
    subject: message.subject,
    html: message.html,
    text: message.text,
    fromName: message.fromName,
    idempotencyKey: target.deliveryKey,
  }, {
    db,
    env: env as unknown as Record<string, unknown>,
    encryptionKey,
    // An app sender runs on a detached context: background work has no request.
    appProviders: detachedAppProviders(env, db, encryptionKey),
  });

  const receiptResult: AuthOtpDeliveryReceiptResult = {
    provider: result.provider,
    providerMessageId: result.providerRef,
    providerStatus: result.rawStatus ?? (result.success ? "accepted" : "failed"),
  };

  if (!result.success) {
    throw createAuthOtpDeliveryError(
      `OTP email delivery unavailable: ${result.rawStatus ?? result.provider}`,
      receiptResult,
      {
        terminal: result.retryable === false || isAuthOtpNonRetryableStatus(result.rawStatus) || result.provider === "log",
        blockProvider: {
          channel: "email",
          provider: "email",
          reason: result.rawStatus ?? "email_provider_not_configured",
        },
      },
    );
  }

  console.log(
    `[otp] Sent OTP email delivery=${target.deliveryKey} recipientHashPrefix=${getAuthOtpRecipientHashPrefix(target.identifierHash)}`,
  );
  return receiptResult;
}

async function sendAuthOtpWhatsApp(
  payload: ResolvedAuthOtp,
  code: string,
  target: { deliveryKey: string; channel: AuthOtpDeliveryChannel; identifierHash: string },
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<AuthOtpDeliveryReceiptResult> {
  // The built-in Meta Cloud API, or the app messaging provider the merchant
  // chose. An app runs on a detached context: background work has no request.
  const encryptionKey = getCredentialEncryptionKey(env as unknown as Record<string, unknown>);
  const sender = await resolveWhatsAppSender(db, {
    encryptionKey,
    appProviders: detachedAppProviders(env, db, encryptionKey),
  });
  const block = await getNotificationProviderBlock(db, {
    channel: "whatsapp",
    provider: sender.provider,
  });
  if (block) {
    throw createAuthOtpDeliveryError(
      buildAuthOtpProviderBlockedReason(block.reason),
      {
        provider: sender.provider,
        providerStatus: "provider_blocked_until_settings_save",
        rawResponse: block.reason,
      },
      { terminal: true },
    );
  }

  if (!sender.ready) {
    const builtIn = sender.provider === "whatsapp";
    throw createAuthOtpDeliveryError(
      builtIn ? "WhatsApp credentials are not configured" : "The WhatsApp provider is not ready",
      {
        provider: sender.provider,
        providerStatus: builtIn ? "missing_credentials" : "provider_not_ready",
      },
      {
        terminal: true,
        blockProvider: {
          channel: "whatsapp",
          provider: sender.provider,
          reason: builtIn ? "missing_credentials" : `not configured: ${redactAuthOtpLogText(sender.reason)}`,
        },
      },
    );
  }

  const result = await sender.sendTemplate({
    to: payload.identifier,
    templateName: sender.authTemplateName,
    languageCode: "en_US",
    bodyParameters: [code],
    idempotencyKey: createAuthOtpProviderClientReference(target),
  });

  const receiptResult: AuthOtpDeliveryReceiptResult = {
    provider: sender.provider,
    providerMessageId: result.providerRef,
    providerStatus: result.rawStatus,
    rawResponse: result.rawResponse,
  };

  if (!result.success) {
    throw createAuthOtpDeliveryError(`WhatsApp OTP delivery failed: ${result.rawStatus}`, {
      provider: sender.provider,
      providerMessageId: result.providerRef,
      providerStatus: result.rawStatus,
      rawResponse: result.rawResponse,
    }, {
      terminal: result.retryable === false || isAuthOtpNonRetryableStatus(`${result.rawStatus} ${result.rawResponse ?? ""}`),
      blockProvider: {
        channel: "whatsapp",
        provider: sender.provider,
        reason: `${result.rawStatus} ${result.rawResponse ?? ""}`.trim(),
      },
    });
  }

  console.log(
    `[otp] Sent WhatsApp OTP delivery=${target.deliveryKey} recipientHashPrefix=${getAuthOtpRecipientHashPrefix(target.identifierHash)}`,
  );
  return receiptResult;
}

async function sendAuthOtpSms(
  payload: ResolvedAuthOtp,
  message: AuthOtpMessage,
  target: { deliveryKey: string; channel: AuthOtpDeliveryChannel; identifierHash: string },
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<AuthOtpDeliveryReceiptResult> {
  const encryptionKey = getCredentialEncryptionKey(env as unknown as Record<string, unknown>);
  // An app SMS provider runs on a detached context: background work has no request.
  const smsProvider = await getActiveSmsProvider(db, encryptionKey, detachedAppProviders(env, db, encryptionKey));
  if (!smsProvider) {
    throw createAuthOtpDeliveryError(
      "SMS OTP requested but no SMS provider is configured. Configure an SMS provider in Auth & Access settings.",
      { provider: "sms", providerStatus: "not_configured" },
      {
        terminal: true,
        blockProvider: {
          channel: "sms",
          provider: "sms",
          reason: "not_configured",
        },
      },
    );
  }

  const block = await getNotificationProviderBlock(db, {
    channel: "sms",
    provider: smsProvider.id,
  }) ?? await getNotificationProviderBlock(db, {
    channel: "sms",
    provider: "sms",
  });
  if (block) {
    throw createAuthOtpDeliveryError(
      buildAuthOtpProviderBlockedReason(block.reason),
      {
        provider: smsProvider.id,
        providerStatus: "provider_blocked_until_settings_save",
        rawResponse: block.reason,
      },
      { terminal: true },
    );
  }

  const result = await smsProvider.send({
    to: payload.identifier,  // Already E.164 from customers.phone
    text: message.sms,
    idempotencyKey: createAuthOtpProviderClientReference(target),
  }, {});

  const receiptResult: AuthOtpDeliveryReceiptResult = {
    provider: smsProvider.id,
    providerMessageId: result.providerRef,
    providerStatus: result.rawStatus ?? (result.success ? "accepted" : "failed"),
  };

  if (!result.success) {
    throw createAuthOtpDeliveryError(
      `SMS OTP delivery failed via ${smsProvider.id}: ${result.rawStatus ?? "unknown provider status"}`,
      receiptResult,
      {
        terminal: result.retryable === false || isAuthOtpNonRetryableStatus(result.rawStatus),
        blockProvider: {
          channel: "sms",
          provider: smsProvider.id,
          reason: result.rawStatus ?? "sms_provider_non_retryable_failure",
        },
      },
    );
  }

  console.log(
    `[otp] SMS OTP sent via ${smsProvider.id} delivery=${target.deliveryKey} recipientHashPrefix=${getAuthOtpRecipientHashPrefix(target.identifierHash)}, ref=${result.providerRef}`,
  );
  return receiptResult;
}

type AuthOtpDeliveryError = Error & {
  deliveryResult?: AuthOtpDeliveryReceiptResult;
  terminal?: boolean;
  blockProvider?: {
    channel: AuthOtpDeliveryChannel;
    provider: string;
    reason: string;
  };
};

function createAuthOtpDeliveryError(
  message: string,
  deliveryResult?: AuthOtpDeliveryReceiptResult,
  options: {
    terminal?: boolean;
    blockProvider?: AuthOtpDeliveryError["blockProvider"];
  } = {},
): AuthOtpDeliveryError {
  const error = new Error(message) as AuthOtpDeliveryError;
  error.deliveryResult = deliveryResult;
  error.terminal = options.terminal;
  error.blockProvider = options.blockProvider;
  return error;
}

function getAuthOtpDeliveryFailureResult(error: unknown): AuthOtpDeliveryReceiptResult {
  if (error instanceof Error && "deliveryResult" in error) {
    return (error as AuthOtpDeliveryError).deliveryResult ?? {};
  }
  return {};
}

function isAuthOtpTerminalDeliveryFailure(
  error: unknown,
  result: AuthOtpDeliveryReceiptResult,
): boolean {
  if (error instanceof Error && "terminal" in error && (error as AuthOtpDeliveryError).terminal) {
    return true;
  }

  const status = [result.providerStatus, result.rawResponse, error instanceof Error ? error.message : String(error)]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return isAuthOtpNonRetryableStatus(status);
}

function getAuthOtpTerminalDeliveryReason(
  error: unknown,
  result: AuthOtpDeliveryReceiptResult,
): string {
  if (result.providerStatus === "provider_blocked_until_settings_save") {
    return error instanceof Error
      ? error.message
      : buildAuthOtpProviderBlockedReason(result.rawResponse ?? "provider_setup_failure");
  }

  return result.providerStatus
    ?? result.rawResponse
    ?? (error instanceof Error ? error.message : String(error))
    ?? "provider_non_retryable_failure";
}

function isAuthOtpNonRetryableStatus(value: string | null | undefined): boolean {
  const status = value?.trim();
  if (!status) return false;

  return AUTH_OTP_NON_RETRYABLE_PATTERNS.some((pattern) => pattern.test(status));
}

async function blockAuthOtpProviderForMerchantActionableFailure(
  db: ReturnType<typeof getDb>,
  target: { channel: AuthOtpDeliveryChannel; provider: string },
  error: unknown,
  result: AuthOtpDeliveryReceiptResult,
): Promise<void> {
  if (result.providerStatus === "provider_blocked_until_settings_save") return;

  const typedError = error instanceof Error ? error as AuthOtpDeliveryError : undefined;
  const candidate = typedError?.blockProvider ?? {
    channel: target.channel,
    provider: result.provider ?? target.provider,
    reason: getAuthOtpTerminalDeliveryReason(error, result),
  };

  if (!isAuthOtpProviderSetupFailure(candidate.reason)) return;

  await markNotificationProviderBlocked(db, candidate).catch((blockError: unknown) => {
    console.error(
      `[otp] Failed to block OTP ${candidate.channel}/${candidate.provider} provider after setup failure:`,
      blockError instanceof Error ? blockError.message : blockError,
    );
  });
}

function isAuthOtpProviderSetupFailure(value: string | null | undefined): boolean {
  const status = value?.trim();
  if (!status) return false;
  return isNotificationProviderBreakerFailure(status)
    || AUTH_OTP_PROVIDER_SETUP_PATTERNS.some((pattern) => pattern.test(status));
}

function buildAuthOtpProviderBlockedReason(reason: string): string {
  return `provider_blocked_until_settings_save: ${reason}`;
}

function redactAuthOtpLogText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[phone]")
    .replace(/\b\d{6}\b/g, "[code]");
}

function getAuthOtpRecipientHashPrefix(identifierHash: string): string {
  return identifierHash.slice(0, 12);
}

const AUTH_OTP_NON_RETRYABLE_PATTERNS = [
  /no configured .*provider/i,
  /no active .*provider/i,
  /provider .*not ready/i,
  /not configured/i,
  /missing[_\s-]?credentials/i,
  /could not be decrypted/i,
  /credential/i,
  /auth(?:orization|entication)?\s+(?:required|failed|error)/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /invalid\s+(?:api\s*)?(?:key|token|credential)/i,
  /api\s*(?:key|token)\s+(?:invalid|expired|missing|not configured)/i,
  /\b(?:http|status|code|error)?\s*(?:400|401|402|403|404|405|422)\b/i,
  /permission/i,
  /sender/i,
  /invalid[_\s-]?grant/i,
  /private key/i,
  /service account/i,
  /insufficient\s+(?:balance|credit)/i,
  /\bbalance\b/i,
  /account\s+(?:expired|suspended|inactive|disabled)/i,
  /invalid\s+(?:number|mobile|recipient|msisdn)/i,
  /blacklist/i,
  /message\s+(?:empty|too\s+long|length)/i,
  /\bpaused\b/i,
];

const AUTH_OTP_PROVIDER_SETUP_PATTERNS = [
  /no configured .*provider/i,
  /no active .*provider/i,
  /provider .*not ready/i,
  /not configured/i,
  /missing[_\s-]?credentials/i,
  /could not be decrypted/i,
  /credential/i,
  /auth(?:orization|entication)?\s+(?:required|failed|error)/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /invalid\s+(?:api\s*)?(?:key|token|credential)/i,
  /api\s*(?:key|token)\s+(?:invalid|expired|missing|not configured)/i,
  /\b(?:http|status|code|error)?\s*(?:401|402|403|405)\b/i,
  /permission/i,
  /sender/i,
  /invalid[_\s-]?grant/i,
  /private key/i,
  /service account/i,
  /insufficient\s+(?:balance|credit)/i,
  /\bbalance\b/i,
  /account\s+(?:expired|suspended|inactive|disabled)/i,
  /\bpaused\b/i,
];
