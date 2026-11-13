// Chat-channel pushes into the inbox (the messaging port's `verifyWebhook`,
// COMMERCE-HOOKS H18):
//
//   GET|POST /webhooks/messaging/{provider}   an app messaging provider (`<plugin id>:<provider id>`)
//
// A channel's subscription check is a GET (Meta echoes `hub.challenge`): the
// app answers it with `reply`. The app authenticates every push before
// anything changes (its secret or signature, from its own settings) and
// answers what it carries: buyer messages and delivery receipts. Each message
// is filed in its contact's thread once per provider and message id (core
// `receiveChannelMessage`), so a channel may resend freely; a message on a
// channel the provider does not declare is ignored. Receipts move the store's
// own outbound lines forward only (`applyChannelReceipt`). Only the port's
// validated answer is applied, never the raw body. Logs carry ids only.
import { OpenAPIHono } from "@hono/zod-openapi";
import { apiNotFoundResponse } from "../../runtime/not-found";
import type { Context } from "hono";
import type { Database } from "@scalius/database/client";
import { applyChannelReceipt, receiveChannelMessage } from "@scalius/core/modules/conversations";
import { resolveChannelContactCustomer } from "@scalius/core/modules/customers";
import {
  isQualifiedProviderId,
  messagingWebhookSchema,
  parseQualifiedProviderId,
  providerErrorOf,
  type MessagingWebhook,
  type MessagingWebhookReply,
  type ProviderHttpRequest,
} from "@scalius/shared/plugins/providers";
import { notificationSender } from "../../background/notification-sender";
import { assertAppProviderInstalled, requestAppProviders } from "../../plugins/providers/app-providers";

const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

/** The push as the port carries it: the exact body, and only headers and query values within its bounds. */
async function toProviderRequest(c: Context): Promise<ProviderHttpRequest> {
  const headers: Record<string, string> = {};
  for (const [name, value] of c.req.raw.headers) {
    if (HEADER_NAME.test(name) && value.length <= 8192) headers[name] = value;
  }
  const query = Object.fromEntries(
    Object.entries(c.req.query()).filter(([key, value]) => key.length <= 128 && value.length <= 8192),
  );
  return { method: c.req.method, rawBody: c.req.method === "GET" ? "" : await c.req.text(), headers, query };
}

/** The channel's expected answer, else a plain acknowledgement. */
function answer(c: Context, reply: MessagingWebhookReply | undefined, fallback: Record<string, unknown>): Response {
  if (!reply) return c.json(fallback);
  if (reply.text !== undefined) return c.text(reply.text, reply.status as 200, reply.headers ?? {});
  return c.json(reply.body ?? fallback, reply.status as 200, reply.headers ?? {});
}

async function handleMessagingWebhook(c: Context<{ Bindings: Env }>, providerId: string): Promise<Response> {
  const db = c.get("db") as Database;
  const choice = await requestAppProviders(c as never).resolve("messaging", providerId);
  const provider = choice.provider;
  if (!provider) {
    // No installed app declares it: nothing here. Installed but not ready: the channel comes back.
    const installed = await assertAppProviderInstalled(db, "messaging", providerId).then(() => true, () => false);
    if (!installed) return apiNotFoundResponse();
    console.warn(`[messaging-webhook] ${providerId} is not ready`);
    return c.json({ error: "Webhook verification unavailable" }, 503);
  }
  if (!provider.verifyWebhook) return apiNotFoundResponse();

  let verification: MessagingWebhook;
  try {
    const parsed = messagingWebhookSchema.safeParse(await provider.verifyWebhook(await toProviderRequest(c), { signal: AbortSignal.timeout(10_000) }));
    if (!parsed.success) {
      console.warn(`[messaging-webhook] ${providerId} answered outside the port`);
      return c.json({ error: "Unauthorized" }, 401);
    }
    verification = parsed.data;
  } catch (error) {
    const failure = providerErrorOf(error);
    if (failure?.category === "declined") {
      console.warn(`[messaging-webhook] ${providerId} rejected (${failure.code ?? "declined"})`);
      return c.json({ error: "Unauthorized" }, 401);
    }
    // A missing secret or an unavailable check: nothing was applied, the channel comes back.
    console.error(`[messaging-webhook] ${providerId} verification unavailable (${failure?.code ?? "provider_call_failed"})`);
    return c.json({ error: "Webhook verification unavailable" }, 503);
  }
  if (verification.status === "invalid") {
    console.warn(`[messaging-webhook] ${providerId} rejected an unauthenticated push`);
    return c.json({ error: "Unauthorized" }, (verification.rejectStatus ?? 401) as 401);
  }
  if (verification.status === "ignored") return answer(c, verification.reply, { received: true });

  const appId = parseQualifiedProviderId(provider.id)!.pluginId;
  const carries = new Set(provider.channels ?? []);
  const send = notificationSender(c);
  const outcomes = { filed: 0, duplicate: 0, ignored: 0, receipts: 0 };
  for (const event of verification.events) {
    if (event.type === "status") {
      if (await applyChannelReceipt(db, provider.id, event) === "applied") outcomes.receipts += 1;
      continue;
    }
    if (!carries.has(event.channel)) {
      outcomes.ignored += 1;
      continue;
    }
    const filed = await receiveChannelMessage(db, {
      providerId: provider.id,
      message: event,
      customerFor: (contact) => resolveChannelContactCustomer(db, contact, appId),
    }, { send });
    outcomes[filed.status === "received" ? "filed" : "duplicate"] += 1;
  }
  return answer(c, verification.reply, { received: true, ...outcomes });
}

const app = new OpenAPIHono<{ Bindings: Env }>();
const route = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  const providerId = c.req.param("provider") ?? "";
  if (!isQualifiedProviderId(providerId)) return apiNotFoundResponse();
  return handleMessagingWebhook(c, providerId);
};
app.get("/:provider", route);
app.post("/:provider", route);
export const messagingWebhookRoutes = app;
