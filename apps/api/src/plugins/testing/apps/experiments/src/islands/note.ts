// The note island: the visitor's variant of the delivery note, picked in the
// browser from the store's visitor id, shown in place of the control, and
// published once as this app's own event (its pixel records the exposure).

import { defineIsland, experimentVariant } from "@scalius/plugin-sdk/island";
import { EXPERIMENT } from "../experiment";

export default defineIsland((element, _props, context) => {
  const variant = experimentVariant(context.visitorId?.() ?? null, EXPERIMENT.key, EXPERIMENT.variants);
  const note = element.querySelector<HTMLElement>(".acme-note");
  if (note && variant === "urgency") note.textContent = "Order in the next hour for delivery tomorrow";
  note?.setAttribute("data-variant", variant);
  context.events?.publish("experiment_viewed", { experiment: EXPERIMENT.key, variant });
  // An add after the exposure: the note says so (an island reacting to the buyer).
  return context.events?.on("product_added_to_cart", () => note?.setAttribute("data-added", "true"));
});
