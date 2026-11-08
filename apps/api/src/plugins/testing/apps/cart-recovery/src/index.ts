// acme.cart-recovery: a reminder for a checkout the buyer left, built only on
// the stable app API.
//
// - `checkout.abandoned` (the checkout idle an hour) files a reminder, due
//   `delay_hours` later; a redelivered event files nothing new.
// - The `remind` cron takes the reminders that are due. For each it reads the
//   checkout again (`abandoned_checkouts.get`): gone means the buyer placed
//   the order (or it aged out), so nothing is sent. Otherwise one marketing
//   e-mail goes to the checkout's customer through `ctx.messaging`, which
//   sends only while that customer is subscribed (the platform's consent
//   check and unsubscribe footer), with the cart's lines and its signed
//   recovery link. The idempotency key makes a retried run send it once.

import { definePlugin, PLUGIN_API_VERSION, type PluginContext, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.cart-recovery",
  name: "Cart Recovery",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Reminds buyers who left their cart, with a link that fills it again: once, and only buyers who agreed to hear from you.",
  author: { name: "Acme" },
  categories: ["marketing"],
  // Abandoned checkouts (read_orders), the customer to e-mail (read_customers)
  // and a marketing e-mail the platform sends only with consent (write_marketing).
  scopes: ["read_orders", "read_customers", "write_marketing"],
  events: ["checkout.abandoned"],
  cron: [{ name: "remind", schedule: "*/15 * * * *" }],
  settings: [{ key: "delay_hours", label: "Hours to wait before the reminder", type: "number", integer: true, min: 1, max: 72, default: 1 }],
  objects: {
    reminders: {
      name: "Reminders",
      fields: [
        { key: "due_at", name: "Due at", type: "integer" },
        { key: "status", name: "Status", type: "single_line_text" },
      ],
      indexes: [["status", "due_at"]],
    },
  },
} satisfies PluginManifestInput;

/** What happened to a reminder: waiting, then sent, or why not. */
export type ReminderStatus = "waiting" | "sent" | "recovered" | "no_consent" | "unreachable";

interface Reminder extends Record<string, unknown> {
  due_at: number;
  status: ReminderStatus;
}

interface CheckoutLine { title: string; quantity: number; totalMinor: number }
interface Checkout {
  customerId: string | null;
  currency: string;
  lines: CheckoutLine[];
  totalMinor: number;
  recoveryUrl: string | null;
}

const reminders = (ctx: PluginContext) => ctx.objects.reminders!;
const HOUR = 60 * 60 * 1000;

const escape = (value: string) => value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const money = (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`;

function reminderEmail(checkout: Checkout & { recoveryUrl: string }) {
  const rows = checkout.lines.map((line) => `<li>${escape(line.title)} × ${line.quantity}: ${money(line.totalMinor, checkout.currency)}</li>`).join("");
  return {
    subject: "You left something in your cart",
    html: `<p>Your cart is waiting.</p><ul>${rows}</ul><p>Total ${money(checkout.totalMinor, checkout.currency)}</p><p><a href="${escape(checkout.recoveryUrl)}">Back to your cart</a></p>`,
    text: `Your cart is waiting. Back to your cart: ${checkout.recoveryUrl}`,
  };
}

/** Reads the checkout again and sends its one reminder, or says why not. */
async function remind(ctx: PluginContext, checkoutId: string): Promise<ReminderStatus> {
  const read = await ctx.api.call<{ abandonedCheckout?: Checkout }>("abandoned_checkouts.get", { path: { id: checkoutId } });
  // Gone: the buyer placed the order (or the checkout aged out).
  if (!read.ok || !read.data?.abandonedCheckout) return read.status === 404 ? "recovered" : "waiting";
  const checkout = read.data.abandonedCheckout;
  if (!checkout.customerId || !checkout.recoveryUrl || checkout.lines.length === 0) return "unreachable";
  const sent = await ctx.messaging.email({
    customerId: checkout.customerId,
    marketing: true,
    idempotencyKey: `cart-recovery-${checkoutId}`,
    ...reminderEmail({ ...checkout, recoveryUrl: checkout.recoveryUrl }),
  });
  return sent.queued ? "sent" : "no_consent";
}

export default definePlugin({
  manifest,
  events: {
    "checkout.abandoned": async (event, ctx) => {
      if (await reminders(ctx).get(event.resource.id)) return;
      const delay = Number(ctx.settings.delay_hours ?? 1) * HOUR;
      await reminders(ctx).put(event.resource.id, { due_at: Date.parse(event.occurredAt) + delay, status: "waiting" } satisfies Reminder);
    },
  },
  cron: {
    remind: async (ctx, run) => {
      const now = Date.parse(run.scheduledAt);
      const due = await reminders(ctx).query({ where: { status: "waiting" }, orderBy: { field: "due_at", direction: "asc" }, limit: 50 });
      for (const record of due.records) {
        const reminder = record.data as Reminder;
        if (reminder.due_at > now) break;
        const status = await remind(ctx, record.id);
        if (status !== "waiting") await reminders(ctx).put(record.id, { ...reminder, status } satisfies Reminder);
      }
    },
  },
});
