# Examples

Complete apps built only on `@scalius/plugin-sdk`, each with its tests. They ship with the package, so an app finds them in `node_modules/@scalius/plugin-sdk/examples`. Copy the `src/` of the closest one into an app you scaffolded with `pnpm plugin create`, then rename its id.

| Example | What it shows |
| --- | --- |
| [`pos`](pos/src/index.ts) | A point of sale on the stable app API: its own sales channel, cashiers from `staff.list`, an in-person sale with `orders.create` and `pointOfSale`, keyed by the till's sale id so a retry sells nothing twice. |
| [`reviews`](reviews/src/index.ts) | A review import (`reviews.create`, verified only on a delivered order line, idempotent by the source's own review key) and moderation under each review's revision. |
| [`cart-recovery`](cart-recovery/src/index.ts) | `checkout.abandoned`, a wait in a cron, a fresh `abandoned_checkouts.get` and one marketing email that goes only to a subscribed buyer. Its test covers a buyer who is not subscribed. |
| [`delivery-slots`](delivery-slots/src/index.ts) | A checkout attribute drawn by a Buyer UI extension, a declared read of the chosen slot, and a `cart.validate` hold (`commit`). Its test races two checkouts for the last place with `harness.commit`. |
| [`pixel`](pixel/src/index.ts) | A pixel (`src/pixel.ts`) that sends buyer events to a collector after marketing consent. Its test runs it with `createPixelTestHarness` and `fixtures.buyerEvent`, including events whose money is null. |
| [`chat`](chat/src/index.ts) | A provider: `definePlugin({ providers: { channels: defineMessagingProvider(…) } })` carries WhatsApp and Messenger into the store's inbox and sends staff replies back, with `conversations.*` on the stable app API. |

Run their tests from a Scalius checkout with `pnpm exec vitest run packages/plugin-sdk/examples`.
