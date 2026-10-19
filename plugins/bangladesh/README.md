# Bangladesh pack (`scalius.bangladesh`)

A first-party app with what a store in Bangladesh needs and a store elsewhere does not. It is for merchants who set it up and for contributors who change it. The app uses only the public plugin contract (`packages/plugin-sdk/README.md`). Core has no Bangladesh payment gateway, courier, SMS gateway, fraud checker or place list of its own.

Every service is a **feature** (`manifest.features`, `docs/platform/PLUGINS.md`). Each starts off. A merchant turns on only the services the store uses, and each one asks for its own access when it is turned on.

| Part | What it gives | Features | Code |
|------|---------------|----------|------|
| Payments | bKash (Tokenized Checkout: execute on return, status query, refunds), Nagad (unverified: no refunds) and SSLCommerz (sessions, IPN and return validation, transaction query, refunds) as hosted payment providers | `bkash`, `nagad`, `sslcommerz` | `src/bkash/`, `src/nagad/`, `src/sslcommerz.ts` |
| Couriers | Pathao and Steadfast as courier providers: booking, tracking, Steadfast's lookup by order number, tracking pushes | `pathao`, `steadfast` | `src/couriers.ts` |
| SMS | SMS.net.bd, BDBulkSMS (GreenWeb), MIM SMS and GenNet iSMS as SMS providers | `smsnetbd`, `bdbulksms`, `mimsms`, `gennet` | `src/sms.ts` |
| Fraud checks | FraudBD, FraudGuard, eCourier Fraud Alert and the custom fraudchecker.link API as fraud providers, for Bangladesh buyers only | `fraudbd`, `fraudguard`, `ecourier`, `fraudchecker` | `src/fraud.ts` |
| Places | The City, Thana and Area list: 66 cities, 1,258 thanas, 10,226 areas from Pathao's delivery places (recommended during setup); Refresh from Pathao is part of the `pathao` feature | `places` | `src/places.ts`, `src/pathao-places.ts`, `places/` |

RedX joins when RedX publishes API documentation that can be read (its developer page renders no documentation).

## Install

- **Bundled (Workers Free, and the demo).** `pnpm plugin add plugins/bangladesh`, then deploy. The pack shows in Apps as installed. `scalius.plugins.json` lists it, so a deployment of this repository has it.
- **Sandboxed (Workers Paid).** `pnpm plugin build` writes `dist/plugin.js` (about 2.4 MiB with the places) and `dist/assets/`. There is no install from the dashboard until the registry exists.

A store that picks Bangladesh in the new-store setup (`/admin/welcome`) sees the pack next. It offers **Activate** when the pack is in this deployment, and the `pnpm plugin add` command when it is not.

## Activate and turn on features

1. A Super Admin selects **Review and activate** in Apps. The pack asks for nothing at this step: no scope, no host, no provider port. Nothing runs yet.
2. On the app's page, **Features** lists every service with a switch, all off. **Places** is marked recommended.
3. Turning a feature on opens a consent dialog with that feature's access only, for example:
   - `places`: the `write_places` scope (add and update places through the place import; it cannot delete one);
   - `bkash`: payments, and the bKash hosts `tokenized.pay.bka.sh` and `tokenized.sandbox.bka.sh`;
   - `pathao`: deliveries, the Pathao hosts, and `write_places` for Refresh from Pathao.

   A Super Admin approves it. The feature's provider, settings, routes and jobs start with the same write. Turning a feature off needs no approval: its access is revoked and its provider, routes and jobs stop at once. Its saved keys stay for when it is turned on again.
4. Turning **Places** on loads the places. It sends them in calls of 500, parents first, for at most 20 seconds. The hourly `places-sync` job finishes a load that did not complete. The **Bangladesh places** page (Settings) shows the progress and has **Load places now**.
5. Each service's keys are entered on its page in the pack, under its switch (the Set up links in Settings → Payments, Shipping → Couriers, Notifications and Apps and integrations land there).
6. One switch puts a payment or SMS service to use. A payment feature that is turned on joins checkout's payment methods, after the ones already there, and checkout offers it as soon as its keys are saved; Settings → Payments stays the place to reorder or hide it, and a hidden one is not added back until its feature is turned off and on again. When no SMS service is chosen, the first SMS provider whose keys are saved becomes the notification SMS service. The service's status says "Ready" only while checkout offers it or notifications send through it, and otherwise why not ("Hidden at checkout", "Not used for sending").

An off feature's provider is not offered anywhere; a saved choice of it reads "Turn on <feature> in Bangladesh pack's features to use it."

## Settings

Every key is in the pack's settings. Secrets are sealed with `CREDENTIAL_ENCRYPTION_KEY` and never shown again. Each field belongs to one provider (`group: <provider id>`), so the dashboard shows it only on that service's page in the pack (`/admin/apps/scalius.bangladesh/<feature>`, where the Set up links on Payments, Shipping, Notifications and Apps and integrations land), under the feature's switch; the pack's Overview lists the services that are on with their status. Each provider names the settings it needs (`providers.<kind>[].settings`), so each one is ready or not on its own. A missing key of one gateway never stops another.

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
| bKash | Environment (sandbox by default), app key, app secret, username, password |
| Nagad (unverified) | Environment (sandbox by default), merchant ID, merchant private key (PKCS#8 PEM), Nagad public key; merchant number and server IP (`X-KM-IP-V4`, default `127.0.0.1`) are optional |
| Pathao | API address, client ID, client secret, username, password, store ID (and, for updates, a webhook secret; booking defaults: delivery type, item type, weight in kg) |
| Steadfast | API address, API key, secret key (and, for updates, a webhook token; empty: the secret key) |

- The API URLs have the services' published addresses as defaults. A URL must be https on the service's own host (the app's allowed hosts). Pathao's test account is `https://courier-api-sandbox.pathao.com`.
- A save refuses an obvious placeholder ("test", "your api key", "123456") in a provider's setting. A stored placeholder makes the provider not ready.

## Sending SMS

- SMS.net.bd gets a multipart form. MIM SMS and GenNet get the number without `+`. BDBulkSMS gets it with `+`.
- GenNet gets the message's receipt key as `csms_id` (20 characters). A duplicate (`4023`) counts as already sent.
- A refusal is an answer (`success: false`), retryable only when the same message can pass later (`src/sms-diagnostics.ts`).
- A timeout or a network failure throws a retryable, uncertain `ProviderError`. The platform retries it only with the message's idempotency key.
- Answers keep no phone number, e-mail address or credential. The app logs no request or response.
- Sign-in codes are sent after the response from opaque references only. The platform derives the code at send time and gives the app the number and the text.
- A provider operation's calls to its own gateway do not count against the app's outbound request limit, so a burst of sign-in codes is not throttled.

## SSLCommerz

- A session per attempt (`src/sslcommerz.ts`) (`tran_id` is the platform's reference, `value_a`/`value_b` the payment type and the order), BDT only, 10 to 500,000 taka (`amountLimits`), the amount as sent (no codec).
- SSLCommerz signs neither its IPN nor the buyer's return. A payment counts only after the validation API answers for its `val_id`, and only when that answer agrees with its transaction, order and payment type. A tampered or unfinished answer changes nothing.
- A failed or cancelled return posts `tran_id` unsigned. The pack declares the field (`returnCorrelationField`); the platform releases the attempt it names without calling the pack.
- `queryPayment` (the receipt page's "check payment") asks the transaction query by session key, then validates the payment it names, so the event is the IPN's.
- A refund goes to the merchant refund API once per refund reference (`refund_trans_id`, at most 30 characters). A refusal or a lost answer is kept for reconciliation (`refundStatus` by `refund_ref_id`), never sent again.
- New sessions use the platform's routes: IPN `/api/v1/webhooks/scalius.bangladesh:sslcommerz`, returns `/api/v1/payment/scalius.bangladesh:sslcommerz/{success,fail,cancel}`.
- **Test connection** runs one transaction query for a reference no payment has; SSLCommerz answers it only with working credentials.
- The SSLCommerz mark in Settings → Payments is the pack's (`assets/sslcommerz.png`); the storefront shows a copy.

## bKash

- Tokenized Checkout v1.2.0-beta (`src/bkash/`). `createSession` creates one bKash payment per checkout attempt and sends the buyer to bKash's page. A retried session gets the same payment.
- On the return, the pack completes the payment with its own server-to-server Execute call; bKash charges nothing before it. A cancelled, failed or repeated return is settled with Query Payment. The return's parameters only name the payment to ask about.
- No webhooks: bKash's merchant notifications travel through AWS SNS and add nothing, since a payment completes only when the pack executes it.
- Refunds go to bKash's refund API at most once per idempotency key, and a lost answer is probed, never sent again.
- The grant token is cached in the pack's KV (`bkash:token:<environment>:<account hash>`), keyed by environment, app key and username, never a secret.
- Storage: `bkash-payments` (by attempt) and `bkash-refunds` (unique bKash refund id).

## Nagad (unverified)

> [!WARNING]
> **UNVERIFIED.** Built from Nagad's published Online Payment API documentation without access to a Nagad sandbox. The tests use only a mock Nagad server (`src/nagad/mock-nagad.ts`). Before real payments, verify it with a live merchant account: a small real payment, a cancelled one and a failed one.

- Initialize and complete (RSA PKCS#1 v1.5 sealed, SHA256withRSA signed, challenge checked), then the buyer pays on Nagad's page. The return and status checks call Verify Payment and match the reference, order, merchant ID and amount; a forged return costs no Nagad call.
- Nagad's order id is derived from the checkout attempt and a generation number, so a retry never makes a second payment.
- No refunds (refund in the Nagad merchant portal, then record it in Scalius) and no webhooks. BDT only.
- Create the merchant key pair with `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out merchant-private.pem`. **Test connection** checks the settings and both keys locally; only a real payment proves Nagad accepts them.
- Storage: `nagad-payments` (by attempt and generation, and by Nagad's payment reference).

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

- SSLCommerz's hash (`verify_sign`) is not checked: the validation API is the authority. EMI is not offered.
- GenNet must be on a `gennet.com.bd` subdomain.
- Delivery receipts, balance checks and per-message status are not implemented.
- A courier's API address must be on its own host (`api-hermes.pathao.com`, `courier-api-sandbox.pathao.com`, `portal.packzy.com`).
- One Pathao and one Steadfast account per store (the pack's settings).
- Webhook IP allowlists are not supported: a push needs its secret (Pathao's answer needs the secret; Steadfast's token falls back to the secret key).

## Testing

```sh
pnpm exec vitest run plugins/bangladesh apps/api/src/plugins/bangladesh-pack.e2e.test.ts apps/api/src/plugins/bangladesh-couriers.e2e.test.ts apps/api/src/plugins/bangladesh-couriers.outcome.d1.test.ts apps/api/src/plugins/bangladesh-sslcommerz.e2e.test.ts apps/api/src/plugins/bangladesh-bkash.e2e.test.ts
```

- `src/*.test.ts` run the app over the SDK harness with scripted gateway and service answers. The cases script the gateway and service answers.
- `bangladesh-pack.e2e.test.ts` runs the bundled pack on the migrated schema. It covers activation with only the places, BDBulkSMS and FraudBD features on (only their ports and jobs are registered; an off feature's provider says which switch turns it on), the 11,550-place seed, a sign-in code sent from its references, a fraud check, a second activation and an uninstall.
- `bangladesh-couriers.e2e.test.ts` covers the couriers' fail-closed state before activation, the webhook URLs, Pathao's place ids and once-only bulk booking. `bangladesh-couriers.outcome.d1.test.ts` runs core's booking-outcome cases (lost answers, refusals, Steadfast's lookup) through the pack.
- `bangladesh-bkash.e2e.test.ts` takes an order through checkout, a bKash session, the return and the queue with only the bKash feature on.
- `bangladesh-sslcommerz.e2e.test.ts` covers SSLCommerz's fail-closed state before activation, a validated IPN credited once, a tampered IPN, a cancel return, and a refund.
