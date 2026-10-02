// `ctx.messaging`: e-mail and SMS through the store's configured providers
// (the same core integrations order notifications use) and staff pushes
// through the staff notice path. Contact details are resolved here from the
// customer id when the plugin passes one; sending to customers needs the
// `customers.view` permission, since it reaches their contact data.

import { customers } from "@scalius/database/schema";
import { compactPhone, normalizeBdMobile } from "@scalius/shared/phone-input";
import { PluginError } from "@scalius/core/modules/plugins";
import { eq } from "drizzle-orm";
import { pluginWithinRateLimit } from "./authority";
import type { PluginBridgeEnvironment } from "./bridge";

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

function text(value: unknown, field: string, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new PluginError("messaging.invalid", `${field} is text of at most ${max} characters.`);
  }
  return value;
}

export async function sendPluginEmail(
  context: PluginMessagingContext,
  input: { customerId?: string; to?: string; subject: string; html: string; text?: string },
): Promise<{ queued: boolean }> {
  requireContactAccess(context);
  const subject = text(input?.subject, "subject", 200)!;
  const html = text(input?.html, "html", 100_000)!;
  const plain = text(input?.text, "text", 50_000, false);
  if ((input.customerId === undefined) === (input.to === undefined)) {
    throw new PluginError("messaging.invalid", "Pass exactly one of customerId or to.");
  }
  const to = input.customerId !== undefined ? (await customerContact(context, input.customerId)).email : input.to;
  if (typeof to !== "string" || !EMAIL.test(to.trim())) {
    if (input.customerId !== undefined) return { queued: false };
    throw new PluginError("messaging.invalid", "to is an e-mail address.");
  }
  await requireRate(context);
  const env = await context.runtime.composedEnv();
  const { sendEmail } = await import("@scalius/core/integrations/email");
  const result = await sendEmail(
    { to: to.trim(), subject, html, ...(plain ? { text: plain } : {}) },
    { env: env as never, db: context.runtime.db(), encryptionKey: env.CREDENTIAL_ENCRYPTION_KEY },
  );
  return { queued: result.success };
}

export async function sendPluginSms(
  context: PluginMessagingContext,
  input: { customerId?: string; to?: string; text: string },
): Promise<{ queued: boolean }> {
  requireContactAccess(context);
  const message = text(input?.text, "text", 1000)!;
  if ((input.customerId === undefined) === (input.to === undefined)) {
    throw new PluginError("messaging.invalid", "Pass exactly one of customerId or to.");
  }
  const raw = input.customerId !== undefined ? (await customerContact(context, input.customerId)).phone : input.to;
  const compact = typeof raw === "string" ? compactPhone(raw) : "";
  const phone = E164.test(compact) ? compact : normalizeBdMobile(compact);
  if (!phone) {
    if (input.customerId !== undefined) return { queued: false };
    throw new PluginError("messaging.invalid", "to is a phone number (+8801XXXXXXXXX).");
  }
  await requireRate(context);
  const env = await context.runtime.composedEnv();
  const { getActiveSmsProvider } = await import("@scalius/core/integrations/sms");
  const provider = await getActiveSmsProvider(context.runtime.db(), env.CREDENTIAL_ENCRYPTION_KEY);
  if (!provider) throw new PluginError("messaging.unavailable", "No SMS provider is configured.");
  const result = await provider.sendSms({ to: phone, message });
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
