# Bangladesh pack (`scalius.bangladesh`)

A first-party app with what a store in Bangladesh needs and a store elsewhere does not. It is for merchants who set it up and for contributors who change it. The app uses only the public plugin contract (`packages/plugin-sdk/README.md`). Core has no Bangladesh payment gateway, courier, SMS gateway, fraud checker or place list of its own.

| Part | What it gives | Code |
|------|---------------|------|
| Payments | SSLCommerz as a hosted payment provider: sessions, IPN and return validation, transaction query, refunds | `src/sslcommerz.ts` |
| Couriers | Pathao and Steadfast as courier providers: booking, tracking, Steadfast's lookup by order number, tracking pushes | `src/couriers.ts` |
| SMS | SMS.net.bd, BDBulkSMS (GreenWeb), MIM SMS and GenNet iSMS as SMS providers | `src/sms.ts` |
| Fraud checks | FraudBD, FraudGuard, eCourier Fraud Alert and the custom fraudchecker.link API as fraud providers, for Bangladesh buyers only | `src/fraud.ts` |
| Places | The City, Thana and Area list: 66 cities, 1,258 thanas, 10,226 areas from Pathao's delivery places, and a refresh from Pathao's live list | `src/places.ts`, `src/pathao-places.ts`, `places/` |

RedX joins when RedX publishes API documentation that can be read (its developer page renders no documentation). bKash and Nagad stay separate apps.

## Install

- **Bundled (Workers Free, and the demo).** `pnpm plugin add plugins/bangladesh`, then deploy. The pack shows in Apps as installed. `scalius.plugins.json` lists it, so a deployment of this repository has it.
- **Sandboxed (Workers Paid).** `pnpm plugin build` writes `dist/plugin.js` (about 2.4 MiB with the places) and `dist/assets/`. There is no install from the dashboard until the registry exists.

A store that picks Bangladesh in the new-store setup (`/admin/welcome`) sees the pack next. It offers **Activate** when the pack is in this deployment, and the `pnpm plugin add` command when it is not.

## Activate

A Super Admin selects **Review and activate** in Apps. The pack asks for:

- `settings.delivery_locations.import`: to load the places through the place import. It adds and updates places only; it cannot delete one;
- network access to the payment gateway's, couriers', SMS gateways' and checkers' hosts only;
- the payment, courier, SMS and fraud check provider ports.

Activation then does three things:

1. It moves the keys that the store saved in core before the move (see [Keys saved before the pack](#keys-saved-before-the-pack)).
2. It loads the places. It sends them in calls of 500, parents first, for at most 20 seconds. The hourly `places-sync` job finishes a load that did not complete. The **Bangladesh places** page (Settings) shows the progress and has **Load places now**.
3. The next steps show in the setup step and on the places page: set up SSLCommerz in Settings → Payments, add Pathao or Steadfast in Settings → Shipping → Couriers, choose the SMS gateway in Settings → Notifications, and turn on a fraud checker in Settings → Apps and integrations. Each one's keys are entered there, in its setup sheet.

## Settings

Every key is in the pack's settings. Secrets are sealed with `CREDENTIAL_ENCRYPTION_KEY` and never shown again. Each field belongs to one provider (`group: <provider id>`), so the dashboard shows it only in that provider's setup sheet, where the provider is set up (Notifications, Shipping → Couriers, Apps and integrations); the app's page lists each provider as a collapsed group with its status. Each provider names the settings it needs (`providers.<kind>[].settings`), so each one is ready or not on its own. A missing key of one gateway never stops another.

| Provider | Settings it needs |
|----------|-------------------|
| SMS.net.bd | API key (sender ID is optional) |
| BDBulkSMS | Token |
| MIM SMS | Username (email), API key, sender name |
| GenNet iSMS | API token, account address (`https://<name>.gennet.com.bd`), SID |
| FraudBD | API URL, API key, username, password |
| FraudGuard | API URL, API key, API secret |
| eCourier Fraud Alert | API URL, API key, API secret, user ID |
| FraudChecker (custom API) | API URL, bearer token |
| SSLCommerz | Environment (sandbox or live; no default: the store chooses), store ID, store password |
| Pathao | API address, client ID, client secret, username, password, store ID (and, for updates, a webhook secret; booking defaults: delivery type, item type, weight in kg) |
| Steadfast | API address, API key, secret key (and, for updates, a webhook token; empty: the secret key) |

- The API URLs have the services' published addresses as defaults. A URL must be https on the service's own host (the app's allowed hosts). Pathao's test account is `https://courier-api-sandbox.pathao.com`.
- A save refuses an obvious placeholder ("test", "your api key", "123456") in a provider's setting. A stored placeholder makes the provider not ready.

## Keys saved before the pack

Before this app, SSLCommerz, the two couriers, four SMS gateways and four checkers were built into core. A store keeps what it saved:

- Until the pack is active, a saved choice that names an old built-in (`sslcommerz`, `pathao`, `bdbulksms`, `fraudbd`, …) means the pack's provider. It does not take a payment, refund, book, send or check. Checkout never offers SSLCommerz, the old IPN URL answers 503 (SSLCommerz sends it again), and Settings → Payments and the order page say "Activate Bangladesh pack in Apps". It says why: "Activate Bangladesh pack in Apps to use it." This shows in Settings → Shipping → Couriers, Settings → Notifications, on Home, in the fraud check card and on the order page. A buyer sees no phone sign-in while SMS cannot send. The old shipments stay readable, with their tracking pages. The old webhook URLs answer 503 (the courier sends again).
- When the pack is activated, the host (`apps/api/src/plugins/provider-handoff.ts`) does this:
  1. It reads the old keys with the strict reader.
  2. It writes them into the pack's settings. It writes only keys the merchant did not set in the pack.
  3. It repoints the SMS choice, the fraud check rows and the courier rows to the pack (a courier's active row gives the keys, else its newest). The couriers' shipments name the pack's couriers and keep their tracking pages. SSLCommerz: the old `sandbox` flag becomes the environment; a gateway that was on takes its old place (and default) in the checkout's payment methods, one that was off is dropped; unpaid, part-paid and failed orders with their attempts and payment rows name `scalius.bangladesh:sslcommerz`. Paid orders keep `sslcommerz`: the platform resolves it to the pack's provider for refunds, names and late IPNs, and rewriting them would report every old order as changed.
  4. It removes the old fields (a courier row keeps no keys).
- A key that cannot be opened (a rotated `CREDENTIAL_ENCRYPTION_KEY`) or that the settings refuse is not moved. The activation message names it, so the merchant enters it again.
- A second activation moves nothing.

## Sending SMS

The requests and answers are the same as the built-in gateways sent before the move. The only change is the transport: the app's `ctx.http`.

- SMS.net.bd gets a multipart form. MIM SMS and GenNet get the number without `+`. BDBulkSMS gets it with `+`.
- GenNet gets the message's receipt key as `csms_id` (20 characters). A duplicate (`4023`) counts as already sent.
- A refusal is an answer (`success: false`), retryable only when the same message can pass later (`src/sms-diagnostics.ts`).
- A timeout or a network failure throws a retryable, uncertain `ProviderError`. The platform retries it only with the message's idempotency key.
- Answers keep no phone number, e-mail address or credential. The app logs no request or response.
- Sign-in codes go through the queue consumer with opaque references only. The platform derives the code at send time and gives the app the number and the text.
- A provider operation's calls to its own gateway do not count against the app's outbound request limit, so a burst of sign-in codes is not throttled.

## SSLCommerz

- The requests are the same as the built-in gateway sent (`src/sslcommerz.ts`): a session per attempt (`tran_id` is the platform's reference, `value_a`/`value_b` the payment type and the order), BDT only, 10 to 500,000 taka (`amountLimits`), the amount as sent (no codec).
- SSLCommerz signs neither its IPN nor the buyer's return. A payment counts only after the validation API answers for its `val_id`, and only when that answer agrees with its transaction, order and payment type. A tampered or unfinished answer changes nothing.
- A failed or cancelled return posts `tran_id` unsigned. The pack declares the field (`returnCorrelationField`); the platform releases the attempt it names without calling the pack.
- `queryPayment` (the receipt page's "check payment") asks the transaction query by session key, then validates the payment it names, so the event is the IPN's.
- A refund goes to the merchant refund API once per refund reference (`refund_trans_id`, at most 30 characters). A refusal or a lost answer is kept for reconciliation (`refundStatus` by `refund_ref_id`), never sent again.
- New sessions use the platform's routes: IPN `/api/v1/webhooks/scalius.bangladesh:sslcommerz`, returns `/api/v1/payment/scalius.bangladesh:sslcommerz/{success,fail,cancel}`. The URLs SSLCommerz already holds (`/webhooks/sslcommerz`, `/payment/sslcommerz/*`, in the merchant panel and in sessions started before the move) reach the same provider: nothing to change in SSLCommerz's panel.
- **Test connection** runs one transaction query for a reference no payment has; SSLCommerz answers it only with working credentials.
- The SSLCommerz mark in Settings → Payments is the pack's (`assets/sslcommerz.png`); the storefront shows a copy.

## Couriers

- The requests, the answers and the status mapping are the same as the built-in couriers made (`src/couriers.ts`). The transport is `ctx.http`.
- Pathao books by its own city, zone and area ids, which the places carry (`externalIds.pathao`). The pack declares this (`locations`), so the platform refuses a booking without a city or zone id before it writes anything and passes the ids to the pack. Cash on delivery must be whole taka; weight is in kg.
- Steadfast takes the full address as text and cash in taka (with paisa). A lost booking answer is found again by order number (`findShipment`, positive answers only).
- A booking that may have reached the courier without an answer is uncertain: the platform keeps it for reconciliation and never books twice. Only an explicit rejection (HTTP 400, 401, 403, 404, 422) is a certain refusal.
- Shipment details keep no buyer name, phone or address.
- Tracking pushes go to the platform's courier route: `/api/v1/webhooks/couriers/scalius.bangladesh:pathao` and `…:steadfast`. The URLs the couriers knew before the pack (`/api/v1/webhooks/pathao`, `/api/v1/webhooks/steadfast`) are internal forwards to the same route: nothing to change in the couriers' portals.
  - Pathao: the secret in `X-PATHAO-Signature`; its integration check and every accepted push get 202 with `X-Pathao-Merchant-Webhook-Integration-Secret`. No secret saved: 503.
  - Steadfast: `Authorization: Bearer <webhook token or secret key>`. `delivery_status` moves the shipment; `tracking_update` keeps the message. A consignment of another order (by invoice) is refused; a booking recovered by lookup is bound to its consignment.
- The courier marks in Settings → Shipping → Couriers are the pack's (`assets/pathao.svg`, `assets/steadfast.svg`), served like the app icon.

## Fraud checks

- The requests and the normalization of each answer are the same as the built-in checkers made (`src/fraud.ts`). The phone goes out in national form (`01XXXXXXXXX`).
- A check has 10 seconds. A refusal is a `ProviderError` with a merchant-safe message. It never carries the service's body or the buyer's phone.
- Answers are cut to the port's limits (status 80 characters, message 500).
- `testConnection` looks up `+8801700000000`.

## Places

- The dataset is `places/` (`places.json`, `manifest.json`; see `places/README.md`). Its version is the SHA-256 in the manifest.
- The seed is idempotent. The import matches by key, then by the row id the place was exported from. So a store set up before the dataset keeps its rows, and zones, tax regions and addresses keep their places.
- Progress is in the app's KV (`places`). A new pack version with a new dataset loads again through the same import.
- **Uninstall never deletes a place**, with or without the app's data: zones, tax regions and addresses point at them.
- **Refresh from Pathao** (places page) reads Pathao's live cities, thanas and areas with the Pathao keys and imports them (source `bd`, no `finish`: only what Pathao marks unusable turns off). A step makes at most 45 Pathao calls, because the app's own requests share its 60-a-minute limit; the `pathao-places` job (every 5 minutes, idle when no refresh runs) finishes it. Progress is in the app's KV (`pathao-refresh`).

## Limits and gaps

- SSLCommerz's hash (`verify_sign`) is not checked, as before the move: the validation API is the authority. EMI is not offered (it was not before).
- An IPN or return claimed before the move under `sslcommerz` and delivered again after it is claimed again under the pack's id; the payment's reference credits the order at most once.
- GenNet must be on a `gennet.com.bd` subdomain. Before the move, any https address worked.
- Delivery receipts, balance checks and per-message status are not implemented: the built-in gateways had none.
- A courier's API address must be on its own host (`api-hermes.pathao.com`, `courier-api-sandbox.pathao.com`, `portal.packzy.com`). Before the move, any https address worked.
- One Pathao and one Steadfast account per store (the pack's settings). A store with two rows of one courier moves the active row's keys; both rows then use the pack's courier.
- Webhook IP allowlists (`config.allowedWebhookIps`) are gone: they never let a push in without a secret (Pathao's answer needs the secret; Steadfast's token falls back to the secret key).
- A push answered as a duplicate before the move is applied once more after it (its claim was named by the old courier id); applying a state twice changes nothing.
- A store with two saved rows of one checker type keeps the keys of the active row (else the newest). Both rows then point at the pack.

## Testing

```sh
pnpm exec vitest run plugins/bangladesh apps/api/src/plugins/bangladesh-pack.e2e.test.ts apps/api/src/plugins/bangladesh-couriers.e2e.test.ts apps/api/src/plugins/bangladesh-couriers.outcome.d1.test.ts apps/api/src/plugins/bangladesh-sslcommerz.e2e.test.ts
```

- `src/*.test.ts` run the app over the SDK harness with scripted gateway and service answers. The cases are core's tests from before the move.
- `bangladesh-pack.e2e.test.ts` runs the bundled pack on the migrated schema. It covers the handoff of saved keys, the 11,550-place seed, a sign-in code from the queue consumer, a fraud check, a second activation and an uninstall.
- `bangladesh-couriers.e2e.test.ts` covers the couriers' fail-closed state before activation, the handoff of courier rows and shipments, the old webhook URLs, Pathao's place ids and once-only bulk booking. `bangladesh-couriers.outcome.d1.test.ts` runs core's booking-outcome cases (lost answers, refusals, Steadfast's lookup) through the pack.
- `bangladesh-sslcommerz.e2e.test.ts` covers SSLCommerz's fail-closed state before activation, the handoff (keys, environment, checkout choice, open payments), a validated IPN at the old URL credited once, a tampered IPN, a cancel at the old return URL, and a refund of a payment made before the move.
