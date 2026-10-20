// `ctx.messaging`: e-mail, SMS and buyer pushes through the store's configured providers
// (the same core integrations order notifications use) and staff pushes
// through the staff notice path (COMMERCE-HOOKS H5, "Messaging").
//
// Who a message reaches (`@scalius/shared/plugins/messaging`):
//   - a customer by `customerId` needs `customers.view` (read_customers); the
//     contact details are resolved here and never returned to the app;
//   - `to` reaches a staff member's email address, or an address held in one
//     of the app's granted `messaging.recipients` fields (its own Objects,
//     found through the field's index); any other address needs the
//     sensitive `send_messages_any` scope. The store's sender is never a relay
//     for arbitrary mail on `read_customers` alone;
//   - `marketing: true` messages need only `marketing.send` (write_marketing):
//     they go only to a customer subscribed on that channel now (Customers &
//     marketing), to the subscribed address, and e-mail carries the
//     unsubscribe footer and RFC 2369/8058 list headers.
// Every send counts against `planLimits().plugins.messagesPerMinute`, and a
// message is at most `PLUGIN_MESSAGE_LIMITS`.

import { customers, systemKv, user } from "@scalius/database/schema";
import { sha256Hex } from "@scalius/shared/hash";
import { compactPhone, normalizeBdMobile } from "@scalius/shared/phone-input";
import { planLimits } from "@scalius/shared/plan-limits";
import { PLUGIN_MESSAGE_LIMITS, PLUGIN_MESSAGE_RECIPIENT_RULE, pluginMessageTextFits } from "@scalius/shared/plugins/messaging";
import type { ObjectTypeDeclaration } from "@scalius/shared/plugins/objects";
import { PluginError } from "@scalius/core/modules/plugins";
import { and, eq, lte, sql } from "drizzle-orm";
import { pluginWithinMessageRate } from "./authority";
import type { PluginBridgeEnvironment } from "./bridge";
import { createAppProviders } from "./providers/app-providers";
import { createAppProviderRuntime } from "./providers/runtime";

export interface PluginMessagingContext {
  pluginId: string;
  permissions: readonly string[];
  /** Who `to` may reach beyond staff: any address, or the granted recipient fields of the app's own records. */
  recipients: { anyAddress: boolean; fields: ReadonlyArray<{ object: string; field: string }> };
  /** The app's object types (`manifest.objects`), for the recipient lookups. */
  objects: Readonly<Record<string, ObjectTypeDeclaration>>;
  runtime: PluginBridgeEnvironment;
}

const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
const E164 = /^\+[1-9]\d{6,14}$/;

function requireContactAccess(context: PluginMessagingContext): void {
  if (!context.permissions.includes("customers.view")) {
    throw new PluginError("messaging_not_allowed", "Sending to customers needs the read_customers scope.");
  }
}

async function requireRate(context: PluginMessagingContext): Promise<void> {
  const perMinute = planLimits().plugins.messagesPerMinute;
  if (!(await pluginWithinMessageRate(context.runtime.env, context.pluginId, perMinute))) {
    throw new PluginError("rate_limited", `Over ${perMinute} messages a minute; try again in a minute.`);
  }
}

function requireCustomerId(customerId: unknown): string {
  if (typeof customerId !== "string" || customerId.length < 1 || customerId.length > 128) {
    throw new PluginError("messaging_invalid", "customerId is a customer id.");
  }
  return customerId;
}

async function customerContact(context: PluginMessagingContext, customerId: unknown): Promise<{ email: string | null; phone: string | null }> {
  const id = requireCustomerId(customerId);
  const row = await context.runtime.db().select({ email: customers.email, phone: customers.phone })
    .from(customers).where(eq(customers.id, id)).get();
  if (!row) throw new PluginError("messaging_invalid", "The customer was not found.");
  return { email: row.email ?? null, phone: row.phone ?? null };
}

/**
 * Whether `to` (as the app passed it, trimmed) may be messaged: any address
 * with `send_messages_any`, a staff member's email, or a value one of the
 * granted recipient fields holds (one indexed row read per field).
 */
async function recipientAllowed(context: PluginMessagingContext, channel: "email" | "sms", to: string): Promise<boolean> {
  if (context.recipients.anyAddress) return true;
  const db = context.runtime.db();
  if (channel === "email") {
    const staff = await db.select({ id: user.id }).from(user)
      .where(and(eq(user.email, to.toLowerCase()), eq(user.banned, false))).get();
    if (staff) return true;
  }
  if (context.recipients.fields.length === 0) return false;
  const { objectRecordExists } = await import("@scalius/core/modules/objects");
  for (const { object, field } of context.recipients.fields) {
    const declaration = context.objects[object];
    if (declaration && await objectRecordExists(db, context.pluginId, object, declaration, { [field]: to })) return true;
  }
  return false;
}

async function requireRecipient(context: PluginMessagingContext, channel: "email" | "sms", to: string): Promise<void> {
  if (!(await recipientAllowed(context, channel, to))) throw new PluginError("messaging_recipient_not_allowed", PLUGIN_MESSAGE_RECIPIENT_RULE);
}

/**
 * The store's messaging as order notifications send it: the composed env,
 * the credential key, and the app provider a saved SMS or email choice may
 * name (never the calling app itself: the bridge refuses messaging inside a
 * provider operation).
 */
async function messagingRuntime(context: PluginMessagingContext) {
  const env = await context.runtime.composedEnv();
  const db = context.runtime.db();
  const encryptionKey = env.CREDENTIAL_ENCRYPTION_KEY;
  const appProviders = createAppProviders(createAppProviderRuntime({ env, db, ctx: context.runtime.ctx }), encryptionKey);
  return { env, db, encryptionKey, appProviders };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/** Marketing sends: the subscribed address and what the message must carry, or null (not subscribed). */
async function marketingPermission(context: PluginMessagingContext, customerId: string | undefined, channel: "email" | "sms") {
  if (!context.permissions.includes("marketing.send")) throw new PluginError("messaging_not_allowed", "Marketing messages need the write_marketing scope.");
  if (customerId === undefined) {
    throw new PluginError("messaging_invalid", "Marketing messages go to a customerId (consent is per customer).");
  }
  const id = requireCustomerId(customerId);
  const env = await context.runtime.composedEnv();
  const { marketingSendPermission } = await import("@scalius/core/modules/customer-marketing");
  const permission = await marketingSendPermission(context.runtime.db(), { customerId: id, channel }, {
    env: env as never,
    storefrontUrl: (env as { STOREFRONT_URL?: string }).STOREFRONT_URL,
  });
  return permission.allowed ? permission : null;
}

/** Text within `limit` (characters and/or UTF-8 bytes), or a `messaging_invalid` refusal. */
function text(value: unknown, field: string, limit: { chars?: number; bytes?: number }, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (!pluginMessageTextFits(value, limit)) {
    const size = limit.bytes !== undefined ? `${limit.bytes} bytes` : `${limit.chars} characters`;
    throw new PluginError("messaging_invalid", `${field} is text of at most ${size}.`);
  }
  return value;
}

/** Exactly one of `customerId` and `to`, outside marketing. */
function requireOneRecipient(input: { customerId?: unknown; to?: unknown }): void {
  if ((input.customerId === undefined) === (input.to === undefined)) {
    throw new PluginError("messaging_invalid", "Pass exactly one of customerId or to.");
  }
}

/** How long a sent email's key is remembered: a repeat within it sends nothing. */
export const PLUGIN_EMAIL_IDEMPOTENCY_SECONDS = 24 * 60 * 60;
/** A send claim older than this (a run that died mid-send) may be taken again. */
const PLUGIN_EMAIL_SEND_CLAIM_SECONDS = 120;
const IDEMPOTENCY_KEY = /^[\x20-\x7E]{8,200}$/u;

/**
 * Sends at most once per app and `idempotencyKey` within 24 hours (a
 * `system_kv` claim, the stable API's retry window): the first send claims
 * the key, a success keeps it, a failure releases it so a retry sends. A
 * repeat answers `{ queued, duplicate: true }` and sends nothing. A run that
 * died between claiming and sending leaves a claim that expires after two
 * minutes, so its retry sends then (at most one duplicate, never a loss).
 */
async function sendOnce(
  context: PluginMessagingContext,
  key: unknown,
  send: () => Promise<{ queued: boolean }>,
): Promise<{ queued: boolean; duplicate?: boolean }> {
  if (key === undefined) return send();
  if (typeof key !== "string" || !IDEMPOTENCY_KEY.test(key)) throw new PluginError("messaging_invalid", "idempotencyKey is 8 to 200 printable characters.");
  const db = context.runtime.db();
  const storeKey = `app-email:${context.pluginId}:${await sha256Hex(key)}`;
  const now = Math.floor(Date.now() / 1000);
  const won = await db.insert(systemKv)
    .values({ key: storeKey, value: "sending", expiresAt: now + PLUGIN_EMAIL_SEND_CLAIM_SECONDS })
    .onConflictDoUpdate({
      target: systemKv.key,
      set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      setWhere: lte(systemKv.expiresAt, now),
    })
    .returning({ key: systemKv.key });
  if (won.length === 0) {
    const row = await db.select({ value: systemKv.value }).from(systemKv).where(eq(systemKv.key, storeKey)).get();
    return { queued: row?.value === "sent", duplicate: true };
  }
  let result: { queued: boolean };
  try {
    result = await send();
  } catch (error) {
    await db.delete(systemKv).where(eq(systemKv.key, storeKey)).run().catch(() => undefined);
    throw error;
  }
  if (result.queued) {
    await db.update(systemKv).set({ value: "sent", expiresAt: now + PLUGIN_EMAIL_IDEMPOTENCY_SECONDS }).where(eq(systemKv.key, storeKey)).run();
  } else {
    await db.delete(systemKv).where(eq(systemKv.key, storeKey)).run();
  }
  return result;
}

export async function sendPluginEmail(
  context: PluginMessagingContext,
  input: { customerId?: string; to?: string; subject: string; html: string; text?: string; marketing?: boolean; idempotencyKey?: string },
): Promise<{ queued: boolean; duplicate?: boolean }> {
  const subject = text(input?.subject, "subject", { chars: PLUGIN_MESSAGE_LIMITS.subjectChars })!;
  let html = text(input?.html, "html", { bytes: PLUGIN_MESSAGE_LIMITS.htmlBytes })!;
  let plain = text(input?.text, "text", { bytes: PLUGIN_MESSAGE_LIMITS.textBytes }, false);
  if (input?.marketing === true) {
    const permission = await marketingPermission(context, input.customerId, "email");
    if (!permission) return { queued: false };
    await requireRate(context);
    const unsubscribe = permission.unsubscribeUrl!;
    html = `${html}<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#5f6368;">${escapeHtml(permission.footer.text)} <a href="${escapeHtml(unsubscribe)}">${escapeHtml(permission.footer.unsubscribeLabel)}</a></p>`;
    plain = `${plain ?? ""}\n\n${permission.footer.text}\n${permission.footer.unsubscribeLabel}: ${unsubscribe}`.trim();
    return sendOnce(context, input.idempotencyKey, async () => {
      const { env, db, encryptionKey, appProviders } = await messagingRuntime(context);
      const { sendEmail } = await import("@scalius/core/integrations/email");
      const result = await sendEmail(
        { to: permission.contact!, subject, html, text: plain, headers: permission.headers },
        { env: env as never, db, encryptionKey, appProviders },
      );
      return { queued: result.success };
    });
  }
  requireOneRecipient(input);
  let to: string;
  if (input.customerId !== undefined) {
    requireContactAccess(context);
    const email = (await customerContact(context, input.customerId)).email?.trim();
    if (!email || !EMAIL.test(email)) return { queued: false };
    to = email;
  } else {
    if (typeof input.to !== "string" || !EMAIL.test(input.to.trim())) throw new PluginError("messaging_invalid", "to is an e-mail address.");
    to = input.to.trim();
    await requireRecipient(context, "email", to);
  }
  await requireRate(context);
  return sendOnce(context, input.idempotencyKey, async () => {
    const { env, db, encryptionKey, appProviders } = await messagingRuntime(context);
    const { sendEmail } = await import("@scalius/core/integrations/email");
    const result = await sendEmail(
      { to, subject, html, ...(plain ? { text: plain } : {}) },
      { env: env as never, db, encryptionKey, appProviders },
    );
    return { queued: result.success };
  });
}

/** A phone number the SMS providers take (E.164, or a Bangladesh mobile), or null. */
function smsNumber(raw: string | null | undefined): string | null {
  const compact = typeof raw === "string" ? compactPhone(raw) : "";
  return E164.test(compact) ? compact : normalizeBdMobile(compact);
}

export async function sendPluginSms(
  context: PluginMessagingContext,
  input: { customerId?: string; to?: string; text: string; marketing?: boolean },
): Promise<{ queued: boolean }> {
  const message = text(input?.text, "text", { chars: PLUGIN_MESSAGE_LIMITS.smsChars })!;
  const marketing = input?.marketing === true ? await marketingPermission(context, input.customerId, "sms") : undefined;
  if (marketing === null) return { queued: false };
  let phone: string | null;
  if (marketing) {
    phone = smsNumber(marketing.contact);
    if (!phone) return { queued: false };
  } else {
    requireOneRecipient(input);
    if (input.customerId !== undefined) {
      requireContactAccess(context);
      phone = smsNumber((await customerContact(context, input.customerId)).phone);
      if (!phone) return { queued: false };
    } else {
      phone = typeof input.to === "string" ? smsNumber(input.to) : null;
      if (!phone) throw new PluginError("messaging_invalid", "to is a phone number (+8801XXXXXXXXX).");
      await requireRecipient(context, "sms", (input.to as string).trim());
    }
  }
  await requireRate(context);
  const { db, encryptionKey, appProviders } = await messagingRuntime(context);
  const { getActiveSmsProvider } = await import("@scalius/core/integrations/sms");
  const provider = await getActiveSmsProvider(db, encryptionKey, appProviders);
  if (!provider) throw new PluginError("messaging_unavailable", "No SMS provider is configured.");
  const finalMessage = marketing ? `${message}\n\n${marketing.footer.text}\n${marketing.footer.unsubscribeLabel}: ${marketing.unsubscribeUrl}` : message;
  const result = await provider.send({ to: phone, text: finalMessage }, {});
  return { queued: result.success };
}

export async function notifyPluginStaff(
  context: PluginMessagingContext,
  input: { title: string; body?: string; url?: string },
): Promise<void> {
  const title = text(input?.title, "title", { chars: 80 })!;
  const body = text(input?.body, "body", { chars: 300 }, false);
  const url = input?.url;
  if (url !== undefined && (typeof url !== "string" || !/^\/admin(?:\/[^\s]*)?$/.test(url) || url.startsWith("//"))) {
    throw new PluginError("messaging_invalid", "url is a dashboard path starting with /admin.");
  }
  await requireRate(context);
  const env = await context.runtime.composedEnv();
  const { resolveDashboardLink, sendAdminPushNotice } = await import("@scalius/core/modules/notifications");
  await sendAdminPushNotice(context.runtime.db(), env, {
    title,
    body: body ?? "",
    link: url ? resolveDashboardLink(env, url) : null,
    data: { pluginId: context.pluginId, notificationType: "plugin_notice" },
  });
}

/**
 * A browser notification to one buyer through the store's push delivery
 * (Web Push, or the merchant's app push provider). It reaches a customer, so
 * it needs `customers.view`; the link is a store path, never another site.
 */
export async function pushPluginCustomer(
  context: PluginMessagingContext,
  input: { customerId: string; title: string; body?: string; url?: string; tag?: string },
): Promise<{ delivered: boolean }> {
  requireContactAccess(context);
  const customerId = requireCustomerId(input?.customerId);
  const title = text(input.title, "title", { chars: 120 })!;
  const body = text(input.body, "body", { chars: 500 }, false);
  const url = input.url;
  if (url !== undefined && (typeof url !== "string" || !/^\/(?!\/)[^\s\\]{0,1999}$/.test(url) || url.startsWith("/admin"))) {
    throw new PluginError("messaging_invalid", "url is a store path starting with /.");
  }
  const tag = input.tag;
  if (tag !== undefined && (typeof tag !== "string" || !/^[a-z0-9_.:-]{1,64}$/.test(tag))) {
    throw new PluginError("messaging_invalid", "tag is 1 to 64 lowercase letters, digits, dots, colons, dashes or underscores.");
  }
  await requireRate(context);
  const { env, db, appProviders } = await messagingRuntime(context);
  const { sendCustomerPush } = await import("@scalius/core/modules/notifications");
  return sendCustomerPush(db, env as never, appProviders, {
    customerId,
    notification: { title, body: body ?? "", ...(url ? { url } : {}), ...(tag ? { tag: `${context.pluginId}:${tag}`.slice(0, 64) } : {}) },
  });
}
