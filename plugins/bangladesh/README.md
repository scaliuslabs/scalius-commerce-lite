# Bangladesh pack (`scalius.bangladesh`)

A first-party app with what a store in Bangladesh needs and a store elsewhere does not. It is for merchants who set it up and for contributors who change it. The app uses only the public plugin contract (`packages/plugin-sdk/README.md`). Core has no Bangladesh SMS gateway, fraud checker or place list of its own.

| Part | What it gives | Code |
|------|---------------|------|
| SMS | SMS.net.bd, BDBulkSMS (GreenWeb), MIM SMS and GenNet iSMS as SMS providers | `src/sms.ts` |
| Fraud checks | FraudBD, FraudGuard, eCourier Fraud Alert and the custom fraudchecker.link API as fraud providers, for Bangladesh buyers only | `src/fraud.ts` |
| Places | The City, Thana and Area list: 66 cities, 1,258 thanas, 10,226 areas from Pathao's delivery places | `src/places.ts`, `places/` |

Couriers (Pathao, Steadfast, RedX) and SSLCommerz move here in later slices. bKash and Nagad stay separate apps.

## Install

- **Bundled (Workers Free, and the demo).** `pnpm plugin add plugins/bangladesh`, then deploy. The pack shows in Apps as installed. `scalius.plugins.json` lists it, so a deployment of this repository has it.
- **Sandboxed (Workers Paid).** `pnpm plugin build` writes `dist/plugin.js` (about 2.4 MiB with the places) and `dist/assets/`. There is no install from the dashboard until the registry exists.

A store that picks Bangladesh in the new-store setup (`/admin/welcome`) sees the pack next. It offers **Activate** when the pack is in this deployment, and the `pnpm plugin add` command when it is not.

## Activate

A Super Admin selects **Review and activate** in Apps. The pack asks for:

- `settings.delivery_locations.edit`: to load the places through the place import;
- network access to the gateways' and checkers' hosts only;
- the SMS and fraud check provider ports.

Activation then does three things:

1. It moves the keys that the store saved in core before the move (see [Keys saved before the pack](#keys-saved-before-the-pack)).
2. It loads the places. It sends them in calls of 500, parents first, for at most 20 seconds. The hourly `places-sync` job finishes a load that did not complete. The **Bangladesh places** page (Settings) shows the progress and has **Load places now**.
3. The next steps show in the setup step and on the places page: enter the keys in the pack's settings, choose the SMS gateway in Settings → Notifications, and turn on a fraud checker in Settings → Apps and integrations.

## Settings

Every key is in the pack's settings. Secrets are sealed with `CREDENTIAL_ENCRYPTION_KEY` and never shown again. Each provider names the settings it needs (`providers.<kind>[].settings`), so each one is ready or not on its own. A missing key of one gateway never stops another.

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

- The API URLs have the services' published addresses as defaults. A URL must be https on the service's own host (the app's allowed hosts).
- A save refuses an obvious placeholder ("test", "your api key", "123456") in a provider's setting. A stored placeholder makes the provider not ready.

## Keys saved before the pack

Before this app, the four gateways and four checkers were built into core. A store keeps what it saved:

- Until the pack is active, a saved choice that names an old built-in (`bdbulksms`, `fraudbd`, …) means the pack's provider. It does not send or check. It says why: "Activate Bangladesh pack in Apps to use it." This shows in Settings → Notifications, on Home, in the fraud check card and on the order page. A buyer sees no phone sign-in while SMS cannot send.
- When the pack is activated, the host (`apps/api/src/plugins/provider-handoff.ts`) does this:
  1. It reads the old keys with the strict reader.
  2. It writes them into the pack's settings. It writes only keys the merchant did not set in the pack.
  3. It repoints the SMS choice and the fraud check rows to the pack.
  4. It removes the old fields.
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

## Limits and gaps

- GenNet must be on a `gennet.com.bd` subdomain. Before the move, any https address worked.
- Delivery receipts, balance checks and per-message status are not implemented: the built-in gateways had none.
- A store with two saved rows of one checker type keeps the keys of the active row (else the newest). Both rows then point at the pack.

## Testing

```sh
pnpm exec vitest run plugins/bangladesh apps/api/src/plugins/bangladesh-pack.e2e.test.ts
```

- `src/*.test.ts` run the app over the SDK harness with scripted gateway and service answers. The cases are core's tests from before the move.
- `bangladesh-pack.e2e.test.ts` runs the bundled pack on the migrated schema. It covers the handoff of saved keys, the 11,550-place seed, a sign-in code from the queue consumer, a fraud check, a second activation and an uninstall.
