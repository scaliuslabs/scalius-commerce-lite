// Delivery slots (`acme.delivery-slots`): the buyer picks a dated delivery
// slot at checkout, a day and a window (two checkout attributes, drawn by a
// checkout extension with the choices open right now), and the app holds a
// place in it with the order. Proves dynamic checkout choices and `cart.validate`
// holds (G4):
//
// - A slot is a `slots` record whose id joins its day and window
//   (`2026-11-10:am`), holding when it starts, its capacity and how many
//   orders took it.
// - The extension lists the next open slots (a list read through the
//   `starts_at` index, `from: "now"`: the platform reads them in the quote's
//   own batch, never a network call) and offers, as choices computed at
//   quote time, the days that still have room and that day's windows. The
//   choices are only drawn: the answer is text the function checks.
// - `cart.validate` reads the chosen slot by a composite key (`join` of the
//   day and window attributes) and refuses a missing, unknown, started or
//   full slot by the run's clock (`input.now`); otherwise it answers `commit`
//   with one more place taken. The platform writes that record in the
//   order's own batch at the revision the function read: two checkouts
//   racing for the last place cannot both take it (the loser's order is
//   refused, `app_offer_changed`, and its next quote reads the slot full). A
//   checkout that fails, or a quote, takes nothing.
// - `onError: "block"`: when the app cannot answer (or its hold cannot be
//   taken), checkout refuses instead of selling a slot it could not hold.
//
// Places are not given back when an order is cancelled in this example; a
// real app would release them from an `order.cancelled` handler.

import { definePlugin, PLUGIN_API_VERSION, readList, readOne, ui, type FunctionReads, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.delivery-slots",
  name: "Delivery slots",
  version: "0.2.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Buyers choose a delivery day and window at checkout; each slot takes only as many orders as it has room for.",
  author: { name: "Scalius" },
  tagline: "Dated delivery slots with limited room",
  categories: ["shipping"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  minPlatformVersion: "1.0.0",
  checkout: {
    attributes: [
      { key: "day", label: "Delivery day", type: "text", maxLength: 10 },
      { key: "window", label: "Delivery window", type: "text", maxLength: 16 },
    ],
  },
  functions: [
    {
      point: "cart.validate",
      priority: 100,
      onError: "block",
      reads: [{ as: "slot", object: "slots", key: { join: ["attribute.day", "attribute.window"] } }],
    },
  ],
  storefront: {
    extensions: [{
      target: "checkout.contact.after",
      reads: [{ as: "open", object: "slots", list: { orderBy: "starts_at", from: "now", limit: 30 } }],
    }],
  },
  objects: {
    // Record id: `<day>:<window>` (`2026-11-10:am`). `{ label, starts_at, capacity, taken }`.
    slots: {
      name: "Slots",
      fields: [
        { key: "label", name: "Label", type: "single_line_text" },
        { key: "starts_at", name: "Starts at", type: "date_time" },
        { key: "capacity", name: "Capacity", type: "integer" },
        { key: "taken", name: "Taken", type: "integer" },
      ],
      indexes: ["starts_at"],
    },
  },
  translations: {
    bn: {
      name: "ডেলিভারি স্লট",
      tagline: "সীমিত জায়গার তারিখসহ ডেলিভারি স্লট",
      description: "ক্রেতা চেকআউটে ডেলিভারির দিন ও সময় বেছে নেন; প্রতিটি স্লটে যত জায়গা, তত অর্ডারই নেওয়া হয়।",
    },
  },
} satisfies PluginManifestInput;

export interface Slot extends Record<string, unknown> {
  label: string;
  starts_at: string;
  capacity: number;
  taken: number;
}

const whole = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);
const hasRoom = (slot: Slot) => whole(slot.taken) < whole(slot.capacity);
const started = (slot: Slot, now: string | undefined) => !now || Date.parse(slot.starts_at) <= Date.parse(now);

/** The slots still open at `now` (the list read is already from now, in start order), by day. */
export function openSlots(reads: FunctionReads | undefined, now: string | undefined): Map<string, Array<{ window: string; label: string }>> {
  const days = new Map<string, Array<{ window: string; label: string }>>();
  for (const record of readList<Slot>(reads, "open")) {
    const slot = record.data;
    const [day, window] = record.id.split(":");
    if (!day || !window || started(slot, now) || !hasRoom(slot)) continue;
    days.set(day, [...(days.get(day) ?? []), { window, label: slot.label }]);
  }
  return days;
}

export default definePlugin({
  manifest,

  functions: {
    "cart.validate": ({ cart, reads, now }) => {
      if (cart.lines.length === 0) return { errors: [] };
      if (!cart.attributes["acme.delivery-slots.day"] || !cart.attributes["acme.delivery-slots.window"]) {
        return { errors: [{ code: "slot_required", message: "Choose a delivery day and window." }] };
      }
      const slot = readOne<Slot>(reads, "slot");
      if (!slot) return { errors: [{ code: "slot_unknown", message: "That delivery slot is not offered. Choose another." }] };
      if (started(slot.data, now)) return { errors: [{ code: "slot_closed", message: "That delivery slot has started. Choose a later one." }] };
      if (!hasRoom(slot.data)) return { errors: [{ code: "slot_full", message: "That delivery slot is full. Choose another." }] };
      // Hold one place: written with the order, at the revision read, or not at all.
      return { errors: [], commit: [{ as: "slot", record: { ...slot.data, taken: whole(slot.data.taken) + 1 } }] };
    },
  },

  extensions: {
    "checkout.contact.after": ({ reads, now, attributes }) => {
      const days = openSlots(reads, now);
      if (days.size === 0) return { ui: ui.view([ui.text("No delivery slots are open right now.")]) };
      // The windows of the day the buyer chose, else of the first open day.
      const day = attributes.day && days.has(attributes.day) ? attributes.day : [...days.keys()][0]!;
      return {
        ui: ui.view([
          ui.field("day", { choices: [...days.keys()].map((value) => ({ value, label: value })) }),
          ui.field("window", { choices: days.get(day)!.map((slot) => ({ value: slot.window, label: slot.label })) }),
        ]),
      };
    },
  },
});
