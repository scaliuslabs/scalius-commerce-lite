// Scalius Nagad (`scalius.nagad`): Nagad online checkout as a hosted payment
// provider. UNVERIFIED: built from Nagad's documented Online Payment API
// without sandbox access; see README.md before taking real payments.
//
// - createSession: initialize + complete with Nagad, then send the buyer to
//   Nagad's page. Idempotent by the platform's attempt key: a retry gets the
//   same page; once Nagad closed a payment (cancelled, failed, refused), the
//   next try of the same attempt starts a new Nagad order.
// - verifyReturn / queryPayment: never trust the return's query string; ask
//   Nagad's Verify Payment for the reference and match it against what this
//   store created (order, merchant, amount).
// - verifyWebhook: Nagad's public flow has no merchant webhook.
// - Refunds are not declared: Nagad documents no refund API for this flow,
//   so merchants refund in the Nagad merchant portal and record it in Scalius.
//
// Storage: `payments`, one record per Nagad order (its id), found by the
// attempt (latest generation first) or by Nagad's payment reference.

import {
  definePaymentProvider,
  definePlugin,
  PLUGIN_API_VERSION,
  ProviderError,
  type PaymentEvent,
  type PaymentSession,
  type PaymentSessionInput,
  type PluginContext,
  type PluginManifestInput,
  type PluginStorageCollection,
} from "@scalius/plugin-sdk";
import {
  completePayment,
  DEFAULT_SERVER_IP,
  initializePayment,
  NAGAD_HOSTS,
  NAGAD_REFERENCE,
  nagadCredentials,
  nagadEndpoint,
  nagadOutcome,
  parseAmountMinor,
  verifyPayment,
  type NagadCredentials,
  type NagadVerification,
} from "./nagad";
import { bytesToHex } from "./rsa";

export const manifest = {
  id: "scalius.nagad",
  name: "Nagad (unverified)",
  version: "0.1.2",
  apiVersion: PLUGIN_API_VERSION,
  description: "Unverified: Nagad online checkout, built from Nagad's published Online Payment API without sandbox access. Confirm it with a live Nagad merchant account before taking real payments.",
  author: { name: "Scalius" },
  icon: "assets/icon.svg",
  tagline: "Nagad online checkout, not yet verified",
  categories: ["payments"],
  countries: ["BD"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  documentationUrl: "https://github.com/scaliuslabs/scalius-commerce-lite/blob/mono-repo/plugins/nagad/README.md",
  changelogUrl: "https://github.com/scaliuslabs/scalius-commerce-lite/commits/mono-repo/plugins/nagad",
  minPlatformVersion: "1.0.0",
  allowedHosts: NAGAD_HOSTS,
  storage: {
    payments: {
      indexes: [["attempt", "generation"], "paymentReferenceId"],
      unique: [["attempt", "generation"], "paymentReferenceId"],
    },
  },
  settings: [
    {
      key: "environment",
      label: "Environment",
      type: "select",
      required: true,
      default: "sandbox",
      options: [
        { value: "sandbox", label: "Sandbox (test)" },
        { value: "live", label: "Live" },
      ],
    },
    { key: "merchant_id", label: "Merchant ID", type: "text", required: true, maxLength: 40, help: "The merchant ID Nagad assigned to your account." },
    {
      key: "merchant_number",
      label: "Merchant number",
      type: "text",
      maxLength: 14,
      help: "Optional: your Nagad merchant wallet number (01XXXXXXXXX), sent as accountNumber.",
    },
    {
      key: "merchant_private_key",
      label: "Merchant private key",
      type: "secret",
      required: true,
      help: "Your RSA private key, PKCS#8 PEM (-----BEGIN PRIVATE KEY-----). Nagad has the matching public key.",
    },
    {
      key: "nagad_public_key",
      label: "Nagad public key",
      type: "textarea",
      required: true,
      maxLength: 5000,
      help: "The public key Nagad gave you (-----BEGIN PUBLIC KEY-----, or the bare base64 text).",
    },
    {
      key: "server_ip",
      label: "Server IP sent to Nagad",
      type: "text",
      default: DEFAULT_SERVER_IP,
      maxLength: 15,
      help: "Sent as X-KM-IP-V4. Use the IP Nagad whitelisted for you, if it asked for one.",
    },
  ],
  providers: {
    payment: [{
      id: "nagad",
      name: "Nagad",
      // The checkout mark: the logo cropped to its art (the listing icon keeps the padded canvas).
      icon: "assets/mark.svg",
      checkoutName: "Nagad",
      flow: "hosted",
      chargeCurrencies: ["BDT"],
      operations: ["verifyReturn", "queryPayment", "testConnection"],
    }],
  },
  // A session makes two sequential Nagad calls within the platform's request budget.
  limits: { wallMs: 15_000 },
  translations: {
    bn: {
      name: "নগদ (যাচাই করা হয়নি)",
      tagline: "নগদ অনলাইন চেকআউট, এখনও যাচাই করা হয়নি",
      description: "যাচাই করা হয়নি: স্যান্ডবক্স ছাড়া নগদের প্রকাশিত অনলাইন পেমেন্ট API দেখে তৈরি নগদ অনলাইন চেকআউট। আসল পেমেন্ট নেওয়ার আগে একটি লাইভ নগদ মার্চেন্ট অ্যাকাউন্টে এটি যাচাই করে নিন।",
      settings: {
        environment: { label: "পরিবেশ", options: { sandbox: "স্যান্ডবক্স (পরীক্ষা)", live: "লাইভ" } },
        merchant_id: { label: "মার্চেন্ট ID", help: "নগদ আপনার অ্যাকাউন্টের জন্য যে মার্চেন্ট ID দিয়েছে।" },
        merchant_number: { label: "মার্চেন্ট নম্বর", help: "ঐচ্ছিক: আপনার নগদ মার্চেন্ট ওয়ালেট নম্বর (01XXXXXXXXX), যা accountNumber হিসেবে পাঠানো হয়।" },
        merchant_private_key: { label: "মার্চেন্টের প্রাইভেট কী", help: "আপনার RSA প্রাইভেট কী, PKCS#8 PEM (-----BEGIN PRIVATE KEY-----)। এর সঙ্গে মিলে এমন পাবলিক কী নগদের কাছে আছে।" },
        nagad_public_key: { label: "নগদের পাবলিক কী", help: "নগদ আপনাকে যে পাবলিক কী দিয়েছে (-----BEGIN PUBLIC KEY-----, অথবা শুধু base64 লেখা)।" },
        server_ip: { label: "নগদে পাঠানো সার্ভারের IP", help: "X-KM-IP-V4 হিসেবে পাঠানো হয়। নগদ আপনার জন্য কোনো IP অনুমোদন করে দিয়ে থাকলে সেটি ব্যবহার করুন।" },
      },
    },
  },
} satisfies PluginManifestInput;

/** Nagad's merchant order id: alphanumeric, at most 20 characters. */
const NAGAD_ORDER_ID_LENGTH = 20;
/** A buyer return has no deadline of its own; answer well within the invocation's wall time. */
const RETURN_VERIFY_TIMEOUT_MS = 8_000;
const EVENT_TYPE = "nagad.payment";

type PaymentFacts = {
  /** SHA-256 of the platform's attempt key: every Nagad order of one attempt. */
  attempt: string;
  /** 0 for the attempt's first Nagad order, then one more each time the previous one closed. */
  generation: number;
  nagadOrderId: string;
  /** Scalius's order id. */
  orderId: string;
  correlationId: string;
  amountMinor: number;
  /** The decimal amount sent to Nagad. */
  amount: string;
  createdAt: string;
};

/**
 * - `initializing`: written before initialize, so a lost answer never makes a
 *   retry reuse an order id Nagad may already hold.
 * - `initialized`: Nagad gave a reference; complete has not answered yet.
 * - `redirected`: the buyer was sent to `redirectUrl`.
 * - `closed`: Nagad will not take this payment; the attempt's next try starts a new one.
 */
type NagadPayment = PaymentFacts & (
  | { status: "initializing"; paymentReferenceId: null; challenge: null; redirectUrl: null }
  | { status: "initialized"; paymentReferenceId: string; challenge: string; redirectUrl: null }
  | { status: "redirected"; paymentReferenceId: string; challenge: string; redirectUrl: string }
  | { status: "closed"; paymentReferenceId: string | null; challenge: string | null; redirectUrl: string | null }
);
type InitializedPayment = Extract<NagadPayment, { status: "initialized" }>;

const payments = (ctx: PluginContext) => ctx.storage.payments as PluginStorageCollection<NagadPayment>;

async function sha256Hex(text: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

async function save(ctx: PluginContext, payment: NagadPayment): Promise<void> {
  await payments(ctx).put(payment.nagadOrderId, payment);
}

async function latestPayment(ctx: PluginContext, attempt: string): Promise<NagadPayment | null> {
  const { records } = await payments(ctx).query({ where: { attempt }, orderBy: { field: "generation", direction: "desc" }, limit: 1 });
  return records[0]?.data ?? null;
}

async function paymentByReference(ctx: PluginContext, paymentReferenceId: string): Promise<NagadPayment | null> {
  const { records } = await payments(ctx).query({ where: { paymentReferenceId }, limit: 1 });
  return records[0]?.data ?? null;
}

/** The time left of the session's budget for the next Nagad call. */
function timeLeft(deadline: number): number {
  const remaining = deadline - Date.now();
  // Nothing was sent yet, so running out here is not uncertain.
  if (remaining <= 0) throw new ProviderError("retryable", "The payment timed out before Nagad could be asked. Try again.", { code: "nagad.timeout" });
  return remaining;
}

// ── createSession ───────────────────────────────────────────────────────────

/** A stored payment answers only the attempt that created it. */
function assertSameAttempt(payment: NagadPayment, input: PaymentSessionInput): void {
  if (payment.orderId !== input.orderId || payment.amountMinor !== input.amountMinor) {
    throw new ProviderError("misconfigured", "A different Nagad payment already uses this checkout attempt.", { code: "nagad.attempt_conflict" });
  }
}

async function startPayment(
  ctx: PluginContext,
  credentials: NagadCredentials,
  input: PaymentSessionInput,
  attempt: string,
  generation: number,
  deadline: number,
): Promise<InitializedPayment> {
  const nagadOrderId = (await sha256Hex(`${attempt}:${generation}`)).slice(0, NAGAD_ORDER_ID_LENGTH);
  const facts: PaymentFacts = {
    attempt,
    generation,
    nagadOrderId,
    orderId: input.orderId,
    correlationId: input.correlationId,
    amountMinor: input.amountMinor,
    amount: input.wireAmount.decimal,
    createdAt: new Date().toISOString(),
  };
  await save(ctx, { ...facts, status: "initializing", paymentReferenceId: null, challenge: null, redirectUrl: null });
  const started = await initializePayment(ctx.http, credentials, nagadOrderId, timeLeft(deadline));
  const initialized: InitializedPayment = { ...facts, status: "initialized", ...started, redirectUrl: null };
  await save(ctx, initialized);
  return initialized;
}

async function redirectBuyer(
  ctx: PluginContext,
  credentials: NagadCredentials,
  payment: InitializedPayment,
  callbackUrl: string,
  deadline: number,
): Promise<PaymentSession> {
  let redirectUrl: string;
  try {
    redirectUrl = await completePayment(ctx.http, credentials, {
      paymentReferenceId: payment.paymentReferenceId,
      orderId: payment.nagadOrderId,
      amount: payment.amount,
      challenge: payment.challenge,
      callbackUrl,
      timeoutMs: timeLeft(deadline),
    });
  } catch (error) {
    // Refused (not merely unanswered): this Nagad order can never complete.
    if (error instanceof ProviderError && error.category !== "retryable") await save(ctx, { ...payment, status: "closed" });
    throw error;
  }
  await save(ctx, { ...payment, status: "redirected", redirectUrl });
  ctx.log.info("Nagad payment started", { orderId: payment.orderId, nagadOrderId: payment.nagadOrderId });
  return { providerRef: payment.paymentReferenceId, redirectUrl };
}

// ── Verification ────────────────────────────────────────────────────────────

type Assessment =
  | { kind: "mismatch"; reason: string }
  | { kind: "pending"; status: string }
  | { kind: "event"; event: PaymentEvent };

/** Small audit facts for the event: never the buyer's or merchant's mobile number. */
function factsOf(payment: NagadPayment, verification: NagadVerification): Record<string, string | null> {
  return {
    nagadOrderId: payment.nagadOrderId,
    status: verification.status.slice(0, 100),
    statusCode: verification.statusCode?.slice(0, 40) ?? null,
  };
}

/**
 * What Nagad's Verify answer means for a payment this store created. The
 * same capture always yields the same `eventType` + `eventId`, whichever
 * path (return or query) asked.
 */
function assess(payment: NagadPayment, verification: NagadVerification, merchantId: string): Assessment {
  if (verification.paymentRefId !== payment.paymentReferenceId || verification.orderId !== payment.nagadOrderId) {
    return { kind: "mismatch", reason: "Nagad's answer is for a different payment." };
  }
  if (verification.merchantId !== null && verification.merchantId !== merchantId) {
    return { kind: "mismatch", reason: "Nagad's answer is for a different merchant." };
  }
  const outcome = nagadOutcome(verification.status);
  const identity = { eventType: EVENT_TYPE, orderId: payment.orderId, providerRef: verification.paymentRefId };
  if (outcome === "pending") return { kind: "pending", status: verification.status };
  if (outcome === "cancelled" || outcome === "failed") {
    return {
      kind: "event",
      event: {
        ...identity,
        kind: outcome,
        // Distinct from the capture's id, so a later capture of the same reference is never taken for a replay.
        eventId: `${verification.paymentRefId}:${outcome}`,
        correlationId: payment.correlationId,
        details: factsOf(payment, verification),
      },
    };
  }
  // BDT's wire exponent is its ISO exponent (no amount codec), so Nagad's paisa are Scalius's minor units.
  if (verification.amount === null || parseAmountMinor(verification.amount) !== payment.amountMinor) {
    return { kind: "mismatch", reason: "Nagad reports a different amount than this payment." };
  }
  return {
    kind: "event",
    event: {
      ...identity,
      kind: "confirmed",
      eventId: verification.issuerPaymentRefNo ?? verification.paymentRefId,
      ...(verification.issuerPaymentRefNo ? { secondaryRef: verification.issuerPaymentRefNo } : {}),
      amountMinor: payment.amountMinor,
      currency: "BDT",
      details: factsOf(payment, verification),
    },
  };
}

/** A cancelled or failed Nagad payment is closed, so the attempt's next try starts a new one. */
async function rememberClosed(ctx: PluginContext, payment: NagadPayment, assessment: Assessment): Promise<void> {
  const closed = assessment.kind === "event" && (assessment.event.kind === "cancelled" || assessment.event.kind === "failed");
  if (closed && payment.status !== "closed") await save(ctx, { ...payment, status: "closed" });
}

/** The reference Nagad appended to the return URL. */
function returnedReference(query: Record<string, string>): string | null {
  // An unescaped '+' in the reference arrives decoded as a space.
  const value = (query.payment_ref_id ?? "").replace(/ /g, "+").trim();
  return NAGAD_REFERENCE.test(value) ? value : null;
}

function statusLabel(status: string): string {
  return /^[A-Za-z][A-Za-z _-]{0,39}$/.test(status) ? status : "pending";
}

// ── The provider ────────────────────────────────────────────────────────────

const nagad = definePaymentProvider({
  async createSession(input, ctx) {
    if (input.currency !== "BDT") throw new ProviderError("declined", "Nagad charges only in BDT.", { code: "nagad.currency" });
    const deadline = Date.now() + input.requestTimeoutMs;
    const attempt = await sha256Hex(input.attemptKey);
    const latest = await latestPayment(ctx, attempt);
    if (latest?.status === "redirected") {
      assertSameAttempt(latest, input);
      return { providerRef: latest.paymentReferenceId, redirectUrl: latest.redirectUrl };
    }
    const credentials = await nagadCredentials(ctx.settings);
    let payment: InitializedPayment;
    if (latest?.status === "initialized") {
      // Initialize went through but complete did not answer: finish the same Nagad order.
      assertSameAttempt(latest, input);
      payment = latest;
    } else {
      payment = await startPayment(ctx, credentials, input, attempt, latest ? latest.generation + 1 : 0, deadline);
    }
    return redirectBuyer(ctx, credentials, payment, input.urls.success, deadline);
  },

  verifyWebhook() {
    return { status: "ignored", reason: "Nagad sends no merchant webhooks; payments are verified with Nagad when the buyer returns or when Scalius asks." };
  },

  async verifyReturn(request, ctx) {
    const reference = returnedReference(request.query);
    if (!reference) return { status: "invalid", reason: "The return carries no Nagad payment reference." };
    // Only references this store created are looked up at Nagad: a forged return costs no outbound call.
    const payment = await paymentByReference(ctx, reference);
    if (!payment) return { status: "invalid", reason: "The return matches no Nagad payment this store started." };
    const endpoint = nagadEndpoint(ctx.settings);
    let verification: NagadVerification;
    try {
      verification = await verifyPayment(ctx.http, endpoint, reference, RETURN_VERIFY_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof ProviderError && error.category === "retryable") {
        return { status: "retry", reason: "Nagad could not be reached to verify the payment." };
      }
      throw error;
    }
    const assessment = assess(payment, verification, endpoint.merchantId);
    await rememberClosed(ctx, payment, assessment);
    if (assessment.kind === "mismatch") {
      ctx.log.warn("Nagad return did not match its payment", { orderId: payment.orderId, nagadOrderId: payment.nagadOrderId, reason: assessment.reason });
      return { status: "invalid", reason: assessment.reason };
    }
    if (assessment.kind === "pending") {
      return { status: "ignored", reason: `Nagad reports the payment as ${statusLabel(assessment.status)}; it is not final yet.` };
    }
    return { status: "event", event: assessment.event };
  },

  async queryPayment(input, ctx) {
    const payment = await paymentByReference(ctx, input.providerRef);
    if (!payment || payment.orderId !== input.orderId) {
      throw new ProviderError("declined", "This store started no Nagad payment with this reference for the order.", { code: "nagad.unknown_payment" });
    }
    const endpoint = nagadEndpoint(ctx.settings);
    const verification = await verifyPayment(ctx.http, endpoint, input.providerRef, input.requestTimeoutMs);
    const assessment = assess(payment, verification, endpoint.merchantId);
    await rememberClosed(ctx, payment, assessment);
    if (assessment.kind === "mismatch") {
      throw new ProviderError("declined", `${assessment.reason} Review it in the Nagad merchant portal.`, { code: "nagad.payment_mismatch" });
    }
    const providerStatus = statusLabel(verification.status);
    // The port reports an event from a query only for a captured payment.
    return assessment.kind === "event" && assessment.event.kind === "confirmed" ? { providerStatus, event: assessment.event } : { providerStatus };
  },

  async testConnection(_input, ctx) {
    try {
      const credentials = await nagadCredentials(ctx.settings);
      return {
        ok: true,
        message: `The merchant ID and both keys are valid (${credentials.environment}). Nagad has no test call, so only a real payment proves the connection: place a small order to confirm.`,
      };
    } catch (error) {
      if (error instanceof ProviderError) return { ok: false, message: error.message };
      throw error;
    }
  },
});

export default definePlugin({ manifest, providers: { nagad } });
