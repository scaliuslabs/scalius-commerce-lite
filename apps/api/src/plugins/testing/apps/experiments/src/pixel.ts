// acme.experiments' pixel: the island's exposures and every completed order,
// with the variant the visitor's id gives, to the app's collector.

import { definePixel, experimentVariant } from "@scalius/plugin-sdk/pixel";
import { EXPERIMENT } from "./experiment";

function send(body: Record<string, unknown>): void {
  void fetch("https://ab.acme.example/v1/results", { method: "POST", body: JSON.stringify(body), keepalive: true }).catch(() => undefined);
}

export default definePixel((pixel) => {
  pixel.on("app_event", (event) => {
    if (event.data.name !== "experiment_viewed") return;
    send({ kind: "exposure", experiment: EXPERIMENT.key, visitor: event.context.visitorId, payload: event.data.payload });
  });
  pixel.on("checkout_completed", (event) => {
    const visitor = event.context.visitorId;
    if (!visitor) return;
    send({
      kind: "conversion",
      experiment: EXPERIMENT.key,
      variant: experimentVariant(visitor, EXPERIMENT.key, EXPERIMENT.variants),
      visitor,
      order: event.data.order.id,
      total: event.data.checkout.total,
    });
  });
});
