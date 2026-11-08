// Delivery slots (`acme.delivery-slots`): the buyer picks a delivery slot at
// checkout (a checkout attribute, drawn by a checkout extension), and the
// app holds a place in it with the order. Proves `cart.validate` holds (G4):
//
// - The slot is a `slots` record, keyed by the attribute the buyer chose (a
//   declared read: `attribute.slot`), holding its capacity and how many
//   orders took it.
// - `cart.validate` refuses a missing, unknown or full slot, and otherwise
//   answers `commit` with one more place taken. The platform writes that
//   record in the order's own batch at the revision the function read: two
//   checkouts racing for the last place cannot both take it (the loser's
//   order is refused, `app_offer_changed`, and its next quote reads the slot
//   full). A checkout that fails, or a quote, takes nothing.
// - `onError: "block"`: when the app cannot answer (or its hold cannot be
//   taken), checkout refuses instead of selling a slot it could not hold.
//
// Places are not given back when an order is cancelled in this example; a
// real app would release them from an `order.cancelled` handler.

import { definePlugin, PLUGIN_API_VERSION, readOne, ui, type PluginManifestInput } from "@scalius/plugin-sdk";

export const manifest = {
  id: "acme.delivery-slots",
  name: "Delivery slots",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Buyers choose a delivery slot at checkout; each slot takes only as many orders as it has room for.",
  author: { name: "Scalius" },
  tagline: "Delivery slots with limited room",
  categories: ["shipping"],
  support: { url: "https://github.com/scaliuslabs/scalius-commerce-lite/issues" },
  minPlatformVersion: "1.0.0",
  checkout: { attributes: [{ key: "slot", label: "Delivery slot", type: "text", maxLength: 64 }] },
  functions: [
    { point: "cart.validate", priority: 100, onError: "block", reads: [{ as: "slot", object: "slots", key: "attribute.slot" }] },
  ],
  storefront: { extensions: [{ target: "checkout.contact.after" }] },
  objects: {
    // Record id: the slot's id (`2026-11-10-am`). `{ label, capacity, taken }`.
    slots: {
      name: "Slots",
      fields: [
        { key: "label", name: "Label", type: "single_line_text" },
        { key: "capacity", name: "Capacity", type: "integer" },
        { key: "taken", name: "Taken", type: "integer" },
      ],
    },
  },
  translations: {
    bn: {
      name: "ডেলিভারি স্লট",
      tagline: "সীমিত জায়গার ডেলিভারি স্লট",
      description: "ক্রেতা চেকআউটে ডেলিভারি স্লট বেছে নেন; প্রতিটি স্লটে যত জায়গা, তত অর্ডারই নেওয়া হয়।",
    },
  },
} satisfies PluginManifestInput;

export interface Slot extends Record<string, unknown> {
  label: string;
  capacity: number;
  taken: number;
}

const whole = (value: unknown) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0);

export default definePlugin({
  manifest,

  functions: {
    "cart.validate": ({ cart, reads }) => {
      if (cart.lines.length === 0) return { errors: [] };
      if (!cart.attributes["acme.delivery-slots.slot"]) {
        return { errors: [{ code: "slot_required", message: "Choose a delivery slot." }] };
      }
      const slot = readOne<Slot>(reads, "slot");
      if (!slot) return { errors: [{ code: "slot_unknown", message: "That delivery slot is not offered. Choose another." }] };
      const capacity = whole(slot.data.capacity);
      const taken = whole(slot.data.taken);
      if (taken >= capacity) return { errors: [{ code: "slot_full", message: "That delivery slot is full. Choose another." }] };
      // Hold one place: written with the order, at the revision read, or not at all.
      return { errors: [], commit: [{ as: "slot", record: { ...slot.data, taken: taken + 1 } }] };
    },
  },

  extensions: {
    "checkout.contact.after": () => ({ ui: ui.view([ui.field("slot")]) }),
  },
});
