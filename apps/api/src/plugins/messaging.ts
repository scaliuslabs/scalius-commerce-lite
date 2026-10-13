// `ctx.messaging`: e-mail, SMS and buyer pushes through the store's configured providers
// (the same core integrations order notifications use) and staff pushes
// through the staff notice path. Contact details are resolved here from the
// customer id when the plugin passes one; sending to customers needs the
// `customers.view` permission, since it reaches their contact data.
// `marketing: true` messages go only to a customer subscribed on that channel
// now (Customers & marketing), to the subscribed address, and e-mail carries
// the unsubscribe footer and RFC 2369/8058 list headers.

import { customers } from "@scalius/database/schema";
import { compactPhone, normalizeBdMobile } from "@scalius/shared/phone-input";
import { PluginError } from "@scalius/core/modules/plugins";
import { eq } from "drizzle-orm";
import { pluginWithinRateLimit } from "./authority";
import type { PluginBridgeEnvironment } from "./bridge";
import { createAppProviders } from "./providers/app-providers";
import { createAppProviderRuntime } from "./providers/runtime";

export interface PluginMessagingContext {
  pluginId: string;
  permissions: readonly string[];
  runtime: PluginBridgeEnvironment;
}

const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
const E164 = /^\+[1-9]\d{6,14}$/;

function requireContactAccess(context: PluginMessagingContext): void {
  if (!context.permissions.includes("customers.view")) {
    throw new PluginError("messaging.not_allowed", "Sending to customers needs the customers.view permission.");
  }
}

async function requireRate(context: PluginMessagingContext): Promise<void> {
  if (!(await pluginWithinRateLimit(context.runtime.env, "messaging", context.pluginId))) {
    throw new PluginError("rate_limited", "Too many messages; try again in a minute.");
  }
}

async function customerContact(context: PluginMessagingContext, customerId: unknown): Promise<{ email: string | null; phone: string | null }> {
  if (typeof customerId !== "string" || customerId.length < 1 || customerId.length > 128) {
    throw new PluginError("messaging.invalid", "customerId is a customer id.");
  }
  const row = await context.runtime.db().select({ email: customers.email, phone: customers.phone })
    .from(customers).where(eq(customers.id, customerId)).get();
  if (!row) throw new PluginError("messaging.invalid", "The customer was not found.");
  return { email: row.email ?? null, phone: row.phone ?? null };
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
  if (!context.permissions.includes("marketing.send")) throw new PluginError("messaging.not_allowed", "Marketing messages require marketing.send.");
  if (customerId === undefined) {
    throw new PluginError("messaging.invalid", "Marketing messages go to a customerId (consent is per customer).");
  }
  if (typeof customerId !== "string" || customerId.length < 1 || customerId.length > 128) {
    throw new PluginError("messaging.invalid", "customerId is a customer id.");
  }
  const env = await context.runtime.composedEnv();
  const { marketingSendPermission } = await import("@scalius/core/modules/customer-marketing");
  const permission = await marketingSendPermission(context.runtime.db(), { customerId, channel }, {
    env: env as never,
    storefrontUrl: (env as { STOREFRONT_URL?: string }).STOREFRONT_URL,
  });
  return permission.allowed ? permission : null;
}

function text(value: unknown, field: string, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new PluginError("messaging.invalid", `${field} is text of at most ${max} characters.`);
  }
  return value;
}

export async function sendPluginEmail(
  context: PluginMessagingContext,
  input: { customerId?: string; to?: string; subject: string; html: string; text?: string; marketing?: boolean },
): Promise<{ queued: boolean }> {
  requireContactAccess(context);
  const subject = text(input?.subject, "subject", 200)!;
  let html = text(input?.html, "html", 100_000)!;
  let plain = text(input?.text, "text", 50_000, false);
  if (input?.marketing === true) {
    const permission = await marketingPermission(context, input.customerId, "email");
    if (!permission) return { queued: false };
    await requireRate(context);
    const unsubscribe = permission.unsubscribeUrl!;
    html = `${html}<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#5f6368;">${escapeHtml(permission.footer.text)} <a href="${escapeHtml(unsubscribe)}">${escapeHtml(permission.footer.unsubscribeLabel)}</a></p>`;
    plain = `${plain ?? ""}\n\n${permission.footer.text}\n${permission.footer.unsubscribeLabel}: ${unsubscribe}`.trim();
    const { env, db, encryptionKey, appProviders } = await messagingRuntime(context);
    const { sendEmail } = await import("@scalius/core/integrations/email");
    const result = await sendEmail(
      { to: permission.contact!, subject, html, text: plain, headers: permission.headers },
      { env: env as never, db, encryptionKey, appProviders },
    );
    return { queued: result.success };
  }
  if ((input.customerId === undefined) === (input.to === undefined)) {
    throw new PluginError("messaging.invalid", "Pass exactly one of customerId or to.");
  }
  const to = input.customerId !== undefined ? (await customerContact(context, input.customerId)).email : input.to;
  if (typeof to !== "string" || !EMAIL.test(to.trim())) {
    if (input.customerId !== undefined) return { queued: false };
    throw new PluginError("messaging.invalid", "to is an e-mail address.");
  }
  await requireRate(context);
  const { env, db, encryptionKey, appProviders } = await messagingRuntime(context);
  const { sendEmail } = await import("@scalius/core/integrations/email");
  const result = await sendEmail(
    { to: to.trim(), subject, html, ...(plain ? { text: plain } : {}) },
    { env: env as never, db, encryptionKey, appProviders },
  );
  return { queued: result.success };
}

export async function sendPluginSms(
  context: PluginMessagingContext,
  input: { customerId?: string; to?: string; text: string; marketing?: boolean },
): Promise<{ queued: boolean }> {
  requireContactAccess(context);
  const message = text(input?.text, "text", 1000)!;
  const marketing = input?.marketing === true ? await marketingPermission(context, input.customerId, "sms") : undefined;
  if (marketing === null) return { queued: false };
  if (!marketing && (input.customerId === undefined) === (input.to === undefined)) {
    throw new PluginError("messaging.invalid", "Pass exactly one of customerId or to.");
  }
  const raw = marketing
    ? marketing.contact
    : input.customerId !== undefined ? (await customerContact(context, input.customerId)).phone : input.to;
  const compact = typeof raw === "string" ? compactPhone(raw) : "";
  const phone = E164.test(compact) ? compact : normalizeBdMobile(compact);
  if (!phone) {
    if (input.customerId !== undefined) return { queued: false };
    throw new PluginError("messaging.invalid", "to is a phone number (+8801XXXXXXXXX).");
  }
  await requireRate(context);
  const { db, encryptionKey, appProviders } = await messagingRuntime(context);
  const { getActiveSmsProvider } = await import("@scalius/core/integrations/sms");
  const provider = await getActiveSmsProvider(db, encryptionKey, appProviders);
  if (!provider) throw new PluginError("messaging.unavailable", "No SMS provider is configured.");
  const finalMessage = marketing ? `${message}\n\n${marketing.footer.text}\n${marketing.footer.unsubscribeLabel}: ${marketing.unsubscribeUrl}` : message;
  const result = await provider.send({ to: phone, message: finalMessage }, {});
  return { queued: result.success };
}

export async function notifyPluginStaff(
  context: PluginMessagingContext,
  input: { title: string; body?: string; url?: string },
): Promise<void> {
  const title = text(input?.title, "title", 80)!;
  const body = text(input?.body, "body", 300, false);
  const url = input?.url;
  if (url !== undefined && (typeof url !== "string" || !/^\/admin(?:\/[^\s]*)?$/.test(url) || url.startsWith("//"))) {
    throw new PluginError("messaging.invalid", "url is a dashboard path starting with /admin.");
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
  if (typeof input?.customerId !== "string" || input.customerId.length < 1 || input.customerId.length > 128) {
    throw new PluginError("messaging.invalid", "customerId is a customer id.");
  }
  const title = text(input.title, "title", 120)!;
  const body = text(input.body, "body", 500, false);
  const url = input.url;
  if (url !== undefined && (typeof url !== "string" || !/^\/(?!\/)[^\s\\]{0,1999}$/.test(url) || url.startsWith("/admin"))) {
    throw new PluginError("messaging.invalid", "url is a store path starting with /.");
  }
  const tag = input.tag;
  if (tag !== undefined && (typeof tag !== "string" || !/^[a-z0-9_.:-]{1,64}$/.test(tag))) {
    throw new PluginError("messaging.invalid", "tag is 1 to 64 lowercase letters, digits, dots, colons, dashes or underscores.");
  }
  await requireRate(context);
  const { env, db, appProviders } = await messagingRuntime(context);
  const { sendCustomerPush } = await import("@scalius/core/modules/notifications");
  return sendCustomerPush(db, env as never, appProviders, {
    customerId: input.customerId,
    notification: { title, body: body ?? "", ...(url ? { url } : {}), ...(tag ? { tag: `${context.pluginId}:${tag}`.slice(0, 64) } : {}) },
  });
}
