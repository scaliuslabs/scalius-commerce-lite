// Chat inbox (`acme.chat`): a WhatsApp and Messenger channel as an app, with
// no core edit (COMMERCE-HOOKS H18), and a channel of its own, LINE
// (`customChannels`: `acme.chat:line` on the wire). Its messaging provider
// carries all three both ways:
//
// - `verifyWebhook`: the channel's pushes, signed with a header the app
//   checks, become buyer messages and delivery receipts (the platform files
//   each message once per message id in the contact's thread). The
//   subscription check (a GET with `hub.challenge`) is echoed back.
// - `send`: a staff reply goes out once per idempotency key (its `outbox`
//   object), answering the channel's message id for receipts.
//
// It also helps the store on the stable inbox operations: on
// `conversation.message_received` it reads the thread and its line
// (`read_conversations`) and, on a contact's first message, posts one
// acknowledgement through `conversations.create_message`
// (`write_conversations`), keyed by the thread so a redelivery posts nothing.
// Deterministic and offline: a test fixture, not a shipped app.

import {
  defineMessagingProvider,
  definePlugin,
  PLUGIN_API_VERSION,
  type PluginContext,
  type PluginEvent,
  type PluginManifestInput,
} from "@scalius/plugin-sdk";

export const CHAT_PROVIDER = "acme.chat:channels";
/** The app's own channel as the wire carries it. */
export const LINE_CHANNEL = "acme.chat:line";
/** The fixture channel's push signature (a test value, not a secret). */
export const CHAT_WEBHOOK_SIGNATURE = "acme-chat-test-signature";
export const CHAT_ACKNOWLEDGEMENT = "Thanks for your message! A teammate will reply here shortly.";

export const manifest = {
  id: "acme.chat",
  name: "Chat inbox",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Brings WhatsApp and Messenger chats into the store's inbox and sends staff replies back on the channel.",
  author: { name: "Acme" },
  // The contact's name and number are protected customer data.
  scopes: ["read_conversations", "write_conversations", "read_customer_names", "read_customer_phones"],
  events: ["conversation.message_received"],
  objects: {
    outbox: {
      name: "Sent replies",
      fields: [
        { key: "to", name: "To", type: "single_line_text" },
        { key: "text", name: "Text", type: "multi_line_text" },
        { key: "channel", name: "Channel", type: "single_line_text" },
        { key: "calls", name: "Calls", type: "integer" },
      ],
    },
    seen: {
      name: "Received lines",
      fields: [
        { key: "conversation_id", name: "Conversation", type: "single_line_text" },
        { key: "body", name: "Body", type: "multi_line_text" },
        { key: "contact", name: "Contact", type: "single_line_text" },
      ],
    },
  },
  providers: {
    messaging: [{
      id: "channels",
      name: "Acme Chat",
      channels: ["whatsapp", "messenger"],
      customChannels: [{ key: "line", name: "LINE" }],
      operations: ["verifyWebhook"],
      // The outbox object applies a send once per key.
      dedupesOnIdempotencyKey: true,
    }],
  },
} satisfies PluginManifestInput;

interface OutboxRecord extends Record<string, unknown> { to: string; text: string; channel: string; calls: number }

const channelProvider = defineMessagingProvider({
  async send(input, ctx) {
    const key = input.idempotencyKey ?? `${input.to}:${input.text ?? ""}`.slice(0, 120);
    const outbox = ctx.objects.outbox!;
    const sent = await outbox.get(key) as OutboxRecord | null;
    if (sent) {
      await outbox.update(key, { calls: sent.calls + 1 });
    } else {
      await outbox.put(key, { to: input.to, text: input.text ?? "", channel: input.channel, calls: 1 });
    }
    return { success: true, providerRef: `wamid.out.${key}` };
  },
  async verifyWebhook(request) {
    // The channel's subscription check: echo the challenge it sent.
    if (request.method === "GET") {
      if (request.query["hub.verify_token"] !== CHAT_WEBHOOK_SIGNATURE) return { status: "invalid", reason: "Bad verify token", rejectStatus: 403 };
      return { status: "ignored", reason: "Subscription check", reply: { status: 200, text: request.query["hub.challenge"] ?? "" } };
    }
    if (request.headers["x-acme-chat-signature"] !== CHAT_WEBHOOK_SIGNATURE) return { status: "invalid", reason: "Bad signature" };
    const body = JSON.parse(request.rawBody) as { events?: unknown[] };
    if (!Array.isArray(body.events) || body.events.length === 0) return { status: "ignored", reason: "Nothing for the inbox" };
    return { status: "events", events: body.events as never };
  },
});

interface ConversationRead {
  conversation: { id: string; contact: { name: string | null; address: string | null } | null };
}
interface MessagesRead {
  messages: Array<{ id: string; seq: number; author: string; body: string | null }>;
}

/** Mirrors the buyer's line, and greets a contact on their first message. */
async function onMessage(event: PluginEvent, ctx: PluginContext): Promise<void> {
  const conversationId = typeof event.facts.conversationId === "string" ? event.facts.conversationId : "";
  const messageId = typeof event.facts.messageId === "string" ? event.facts.messageId : "";
  if (!conversationId || !messageId || typeof event.facts.channel !== "string") return;
  const thread = await ctx.api.call<ConversationRead>("conversations.get", { path: { id: conversationId } });
  if (!thread.ok || !thread.data) throw new Error(`conversations.get failed: ${thread.error?.code ?? thread.status}`);
  const lines = await ctx.api.call<MessagesRead>("conversations.list_messages", { path: { id: conversationId }, query: { limit: 50 } });
  if (!lines.ok || !lines.data) throw new Error(`conversations.list_messages failed: ${lines.error?.code ?? lines.status}`);
  const line = lines.data.messages.find((message) => message.id === messageId);
  await ctx.objects.seen!.put(messageId, {
    conversation_id: conversationId,
    body: line?.body ?? "",
    contact: thread.data.conversation.contact?.address ?? "",
  });
  if (event.facts.seq !== 1) return;
  const ack = await ctx.api.call("conversations.create_message", {
    path: { id: conversationId },
    body: { body: CHAT_ACKNOWLEDGEMENT, visibility: "public" },
    idempotencyKey: `acme-chat-ack:${conversationId}`,
  });
  if (!ack.ok) throw new Error(`conversations.create_message failed: ${ack.error?.code ?? ack.status}`);
}

export default definePlugin({
  manifest,
  providers: { channels: channelProvider },
  events: { "conversation.message_received": onMessage },
});
