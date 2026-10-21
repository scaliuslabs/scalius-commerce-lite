# @scalius/plugin-sdk

The SDK for Scalius apps (plugins), for plugin authors. An app declares what it may do (the manifest) and writes the handlers the platform calls. Workspace imports use source; the package build emits portable JavaScript and declarations for publishing.

## Quick start

An app is an ordinary npm package that depends on `@scalius/plugin-sdk`. It can live in its own repository; it does not need a clone of Scalius to build or test.

`@scalius/plugin-sdk` is not on the npm registry yet. `pnpm plugin create` with a `--dir` outside this repository packs this checkout's SDK (`pnpm pack`, the published layout: `dist/` with declarations, no workspace dependencies) into the app's `vendor/` folder, and the app depends on `"@scalius/plugin-sdk": "file:vendor/scalius-plugin-sdk-<version>.tgz"`. Keep the tarball in the app's repository so a clone installs it too. The command prints these steps with your paths (here the checkout is `~/scalius`):

```sh
pnpm plugin create acme.tally --dir ~/code/acme-tally   # from a Scalius checkout
cd ~/code/acme-tally && npm install                     # the SDK build, TypeScript and Vitest
npm test                                                # the harness: the platform's runtime, in memory
npm run typecheck
pnpm --dir ~/scalius plugin validate ~/code/acme-tally  # every check a store makes, including the storefront render
pnpm --dir ~/scalius plugin preview ~/code/acme-tally   # dist/preview.html with fixture data
pnpm --dir ~/scalius plugin pack ~/code/acme-tally --key <folder>   # dist/ and the signed upload ZIP
```

`pnpm --dir ~/scalius plugin keygen ~/.scalius-keys` makes the Ed25519 signing key `--key` takes (once). The tooling uses the SDK the app installed; before `npm install` it uses the checkout's own SDK. For a newer SDK build, repack it, point `package.json` at the new file and run `npm install` again:

```sh
pnpm --dir ~/scalius/packages/plugin-sdk pack --pack-destination ~/code/acme-tally/vendor
```

The scaffold writes `package.json` (no workspace protocol), its own `tsconfig.json`, `src/index.ts` (manifest and handlers), `src/storefront.tsx` (a section), `src/index.test.ts` and a `.gitignore` that keeps `*.pem` out of version control. Inside this repository, `--dir plugins/<name>` (the default) makes a workspace package instead.

## Install and activate an app locally

How a new app reaches a store you run with `pnpm dev` (the same steps work on a deployed Free store, with `pnpm run deploy` instead of the restart):

1. `pnpm plugin validate <app>` passes.
2. `pnpm plugin add <app>` packs it and records it in `scalius.plugins.json`; it regenerates `apps/api/src/plugins/bundled.gen.ts` and, for storefront parts, `apps/storefront/src/extensions/bundled.gen.ts`. An app outside the repository must be an installed package or copied under `plugins/` first (`add` refuses a path outside the repository).
3. Restart `pnpm dev`, so both Workers compile the new generated files.
4. Open the dashboard: Apps. The app is listed as installed, not active: nothing of it runs yet. The Apps page and the scheduled tick sync bundled apps into the database.
5. As a Super Admin, open the app, review the access it asks for (scopes, hosts, storefront parts) and activate it. Its data updates run, then `lifecycle.activate`.
6. Fill its settings on the app's page. Its storefront sections, components and skins are then offered in the theme editor.
7. After a code change: `pnpm plugin build <plugin id>` (or `add` again), restart `pnpm dev`. A new version whose access the approved grant covers stays active; one that asks for more waits for approval.

On Workers Paid with the sandbox on, skip steps 2 and 3: upload the ZIP that `pnpm plugin pack` wrote on the Apps page. An unsigned upload, or one signed by a developer the store does not trust yet, installs only after a Super Admin chooses to trust the developer or to install the unsigned app.

The developer key an app was installed with stays its signer: a registry or uploaded update signed by another key is refused (an app installed unsigned takes the key of its first signed update). To move an app to another developer, uninstall it keeping its data and install the new release. App ids under `scalius.*` are reserved for apps bundled with Scalius; a registry or upload install of one is refused.

Real apps in `plugins/`: `bangladesh` (bKash, Nagad and SSLCommerz payments, SMS, courier history, couriers and place seeding, one feature per service) and `noor` (a theme of skins).

Worked examples that no store bundles are test fixtures in `apps/api/src/plugins/testing/apps/`: `hello` (events, routes, cron, Objects, admin pages), `bulk-discount` (checkout functions), `loyalty` (atomic Objects and order commits), `wholesale` (declared reads: a company price list by one hop, per-SKU minimums, custom fields, a quote spent with the order), `risk-guard` (order risk as an `order.created` handler with `ctx.orders`), `wishlist` (storefront blocks), `order-tagger` (timeline entries), `notes` (declarative checkout and account Buyer UI) and `members` (customer roles, and an import as a background job with a live progress page), `builder` (a store-builder app: batch creates, collections by handle, a template applied with its handles resolved, a footer menu, a customer role), `subscriptions` (a vaulting test payment provider, a purchase option, renewals with `orders.create` and `payments.charge`), `marketplace` (orders split per seller from the fulfilment and refund line facts) and `compose` (card slots, header facts and deferred markup over `studio`'s cards). The versioned contract is `packages/shared/src/plugins`, the host is `apps/api/src/plugins`, and installed-app state is `packages/core/src/modules/plugins`.

## Extension points

| Point | Declare | Implement |
| --- | --- | --- |
| Events | `events` | `events[topic](event, ctx)` |
| Checkout functions | `functions: [{ point, … }]` | `functions[point](input, settings)` |
| Providers (14 ports) | `providers.<port>` | `define<Port>Provider({ … })` |
| Admin routes, pages, cards, actions, widgets | `routes.admin`, `admin.*` | `routes.admin[name]` with `ui.*` |
| Admin list columns and filters | `admin.listColumns` | object records or your custom fields (no code) |
| Order timeline entries | `admin.timeline` | `ctx.timeline.add(…)` |
| Order risk and holds (after commit) | `events: ["order.created"]`, `write_orders` | `ctx.orders.assessRisk(…)`, `ctx.orders.hold(…)` |
| Objects and custom fields | `objects`, `customFields` | `ctx.objects`, `ctx.customFields` |
| Buyer UI | `storefront.extensions: [{ target, reads }]`, `checkout.attributes` | `extensions[target]`, a pure render returning `{ ui }` |
| Storefront components: sections, components in slots and app pages, skins (header, footer, product card, product page, listing, core sections), templates | `storefront.sections`, `components`, `skins`, `templates` | `defineStorefront` in `src/storefront.tsx` (`@scalius/plugin-sdk/storefront`) |
| Client islands, stylesheet, public files | `storefront.islands`, `stylesheet`, `connect` | `src/islands/<name>.ts` (`defineIsland`), `src/storefront.css`, `public/` |
| Scripts, head, proxy | `storefront.scripts`, `head`, `proxy` | |
| Public routes, webhooks | `routes.public`, `routes.webhooks` | `routes.public[name]`, `routes.webhooks[name]` |
| Customer roles | `read_customers` | `ctx.customers.roles.*`; read back as `request.customer.roles` and `cart.customer.roles` |
| Background jobs (long admin actions) | `jobs` | `jobs[name](ctx, job)`, started with `ctx.jobs.start(…)`; show `ui.progress(…)` |
| Cron, data updates, lifecycle | `cron`, `migrations` | `cron[name]`, `migrations[version]`, `lifecycle.*` |
| Sales channels | `salesChannels` | read your channel's products with `ctx.api` |

## A minimal app

```ts
import { defineManifest, definePlugin, PLUGIN_API_VERSION } from "@scalius/plugin-sdk";

export const manifest = defineManifest({
  id: "acme.tally",                  // <vendor>.<name>
  name: "Order tally",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Counts paid orders.",
  author: { name: "Acme" },
  events: ["order.paid"],
  objects: {
    seen: { name: "Processed events", fields: [{ key: "order_id", name: "Order", type: "order_reference" }] },
    tally: { name: "Tallies", fields: [{ key: "count", name: "Count", type: "integer" }] },
  },
});

export default definePlugin({
  manifest,
  events: {
    "order.paid": async (event, ctx) => {
      if (await ctx.objects.seen.get(event.id)) return; // delivery is at least once
      const tally = await ctx.objects.tally.getVersion("paid");
      await ctx.objects.batch([
        { op: "put", object: "seen", id: event.id, record: { order_id: event.resource.id }, expectedRevision: null },
        { op: "put", object: "tally", id: "paid", record: { count: (tally?.data.count ?? 0) + 1 }, expectedRevision: tally?.revision ?? null },
      ]);
    },
  },
});
```

`defineManifest` keeps the manifest's literal types, so `definePlugin` types each handler's `ctx` by it (`PluginContextOf<typeof manifest>`): `ctx.objects.tally` reads `{ count?: number | null }` records, `ctx.settings.<key>` has its field's type (a `select` is the union of its option values; a setting with a default and no feature that switches it off is always present), and a checkout function's `settings` the same. A mistake in the manifest is reported at the key that is wrong (`placement: "buybox"`: Did you mean `"buy-box"`?). A storefront component types its settings with `SectionProps<StorefrontSettingsOf<typeof manifest, "section", "banner">>` (`"block"`, `"skin"`). The typed context is still a `PluginContext`, so helpers that take one keep working. A manifest written inline or with `satisfies PluginManifestInput` keeps the loose types (`ctx.objects.<name>` may be undefined; records are `Record<string, unknown>`).

Test it with the harness. It runs the platform's runtime over an in-memory bridge and enforces the manifest (declared object types, indexed queries, unique indexes, revisions, allowed hosts).

```ts
import { createPluginTestHarness } from "@scalius/plugin-sdk/testing";
import tally from "./index";

const harness = createPluginTestHarness(tally);
await harness.event("order.paid", { type: "order", id: "ord_1" }, {}, { id: "evt_1" });
harness.records.get("tally")?.get("paid"); // { count: 1 }
```

`createPluginTestHarness(module, { settings, store, api, fetch })` answers `ctx.api` and `ctx.http` from the callbacks you pass. For `api`, pass `createContractApi({ handlers })`: it checks every `ctx.api.call` against the stable app API this SDK release was sealed with (`stableContract`) in the host's order and returns the platform's refusal as the result, so a test fails where production would. It refuses an unknown operation (`api_unknown_operation`), an operation no granted scope covers (`api_operation_forbidden`; the harness passes the manifest's scopes), a missing or unsupported `idempotencyKey` (`idempotency_key_required`, `idempotency_not_supported`), a body on a GET, an undeclared body field (`unknown_body_property`), missing or extra path parameters, and any path, query or body value the route's schema rejects (`validation_error`: enums such as a `section`, required fields, the `expectedRevision`/`expectedVersion` preconditions). A repeat with the same key replays the first answer without calling your handler; the same key for another request is `idempotency_key_reused`. A handler returns the response's `data` (checked against the response schema, so a test cannot rely on a shape the platform never returns) or a whole `{ ok: false, status, data: null, error }` refusal such as a 409; a valid call without a handler fails the test. `api.calls` lists each call and its result.

```ts
import { createContractApi, createPluginTestHarness } from "@scalius/plugin-sdk/testing";

const api = createContractApi({
  handlers: { "orders.get": ({ path }) => ({ id: path.id /* …the order resource */ }) },
});
const harness = createPluginTestHarness(plugin, { api });
```
 Methods: `event`, `fn`, `route`, `cron`, `lifecycle`, `provider`, `runJob` (start a job and run its steps to the end), `jobStep` (one step of a job the app started). State: `records`, `kv`, `customFields`, `logs`, `sent` (recorded messages), `roles(customerId)`, `jobs()`. `customers` lists the live customer ids (a role grant to any other is refused, as for a deleted customer).

## Build and install

```sh
pnpm plugin create acme.tally   # scaffold plugins/tally
pnpm install
pnpm plugin add plugins/tally   # pack, check, record in scalius.plugins.json
pnpm run deploy                 # compile the app into the API Worker
```

`pnpm plugin` keeps `scalius.plugins.json` and the generated files in `apps/api/src/plugins/` in step: `bundled.gen.ts`, `sandbox-runtime.gen.ts`, `assets.gen.ts` (the listing images) and `catalog.gen.ts` (the first-party apps in `plugins/` that the lockfile does not list). Do not edit them by hand. Other subcommands:

- `create <vendor.name> [--dir <folder>]` scaffolds an app with an event, a checkout function, a storefront section, an admin page, a data update and a test: a workspace package under `plugins/`, or, anywhere else, a standalone app on the published SDK (Quick start). `validate [path]` checks the manifest, compatibility, handlers, permissions, images, the storefront part (compiled and smoke-rendered with its defaults, exactly as `pack` does: a skin that breaks its target's embed rule fails here) and bundle size, one line each.
- `keygen <dir>` makes an Ed25519 signing key, `<dir>/signing-key.pem` (keep it out of every repository). `pack <path> [--key <pem | dir>] [--developer <name>]` writes `dist/` and, with a key (the PEM, or the folder `keygen` wrote), `signature.json` and the upload ZIP. `index <dist>... --out <dir> --name <name>` builds or extends a static registry. `add <vendor.name> --registry <index URL>` installs a signed release into the fork; `trust <name> <public key>` adds a developer key to the lockfile's `trustedKeys`.
- The harness also runs data updates (`runMigration(version)`, `runMigrations()`) and whole events (`deliver`); `@scalius/plugin-sdk/fixtures` builds typed events, checkout inputs, read records and admin requests.
- `harness.fn(point, input)` is as strict as checkout: it is typed by point, parses the input with the point's schema (a mismatch throws) and checks the answer the way the host does. An invalid answer returns `ok: false` with `function_invalid_output`, which production skips (or, with `onError: "block"`, stops checkout on). Pass `reads` as the host would resolve them. `ctx.messaging` and `ctx.orders` refuse without the scopes the host requires.
- `build [plugin id ...]` packs the listed apps (all by default) again. `list` shows each bundled app and whether it is current. `remove <plugin id>` stops bundling one.
- `sandbox <on|off>` records whether deploys bind the Worker Loader.
- `preview <path> [--out <html>] [--fixture <json>]` packs the app and writes a static preview using SDK fixtures and the real sanitizer. `dev <path> [--fixture <json>]` watches, repacks and refreshes that preview. A view that renders nothing says so. The fixture fills what the defaults leave out, keyed by view (`section:<type>`, `block:<type>`, `skin:<id>`): `{ "product": { "fields": { "engraving": true } }, "settings": { "block:preview": { "maxLetters": 12 } }, "objects": { "section:lookbook": { "looks": { "records": [], "fields": {} } } }, "context": { … } }`; `product` is merged over the fixture product page (blocks and the product_main skin). Core embeds appear as placeholders; this checks component markup and styles, not checkout actions or browser island behavior. Verify the composed journey in a local store before release.
- `wrangler-config [--local] [--plan paid]` prints the API Wrangler config path. A generated config is `wrangler.deploy.gen.json` (`wrangler.local.deploy.gen.json` with `--local`); Free without the sandbox uses the committed config.

After the deploy, the app shows on the Apps page as not active. A Super Admin reviews its requests and activates it. A first-party app in `plugins/` that is not in `scalius.plugins.json` shows under "Available to install" with its `pnpm plugin add` command.

## Two loaders

One module uses the same handler contract in both loaders. Harness tests verify
that contract; they do not prove equivalent isolation, deployment behavior or
performance. Bundled code is trusted code in the host Worker; the Dynamic Worker
has a separate execution boundary. Verify loader-specific behavior separately.

- **Bundled** runs in the API Worker on any plan, from `scalius.plugins.json`. Values crossing the bridge are structured-cloned. A plain `fetch` from app code is refused as in the sandbox, so `ctx.http.fetch` is the only egress on both loaders.
- **Sandbox** needs Workers Paid. Each app version runs in its own Dynamic Worker (binding `LOADER`), cached by id, version and SHA-256. It has no network (`globalOutbound: null`), and the CPU limit `limits.cpuMs` within the plan's ceiling.

An installation with `source` `bundled` uses the bundled loader. `registry` and `upload` use the sandbox; they install from the dashboard (see "Install, update and trust"). A Free deploy has no `LOADER` binding, so sandbox calls fail as `unavailable` (provider calls as `misconfigured`). `pnpm plugin sandbox on` and `pnpm run deploy --plugin-sandbox` bind the loader. [docs/FREE-PLAN.md](../../docs/FREE-PLAN.md) owns the plan rules (the sandbox implies `--plan paid`).

## The manifest

`parsePluginManifest` (`@scalius/plugin-sdk/manifest`) validates it. Unknown keys fail. Limits are in parentheses.

**Names.** Every name and key is snake_case, `^[a-z][a-z0-9_]{0,47}$` (`vendor_split`, `points_banner`): object types and fields, settings, custom fields, timeline kinds, checkout attributes, cron jobs, cards, actions, widgets, tabs, list columns, settings groups and storefront section, block, skin and template ids. A name that is part of a URL may also be kebab-case: route names, page ids, island names, feature ids, provider ids and sales channel ids. A refusal names the rule (`Use snake_case: …`).

- `id`, `name`, `version` (semver), `apiVersion` (`PLUGIN_API_VERSION`, `2026-10`), `description`, `author`: identity. Uploaded apps cannot use `scalius.*` ids.
- `scopes`: access scopes from `PLUGIN_SCOPES` (`read_products`, `write_orders`, ...). The merchant approves them on the consent screen; every `ctx.api` call, timeline write and customer message is checked against the approved ones. A `write_*` scope includes its `read_*`. No scope reaches staff, agent access, webhooks or app management. Stock is `read_inventory`/`write_inventory`, not `write_products`; `write_marketing` sends to consenting customers without revealing their addresses. `read_gift_cards` and `write_gift_cards` (issue, adjust, disable; Sensitive, and the code never reaches the app; `notify` reaches only the owning customer's own contact, an app never changes the owner of a card with a balance, and what one app issues and tops up in a day stays within the merchant's limit, else 403 `app_gift_card_limit`), `write_payments` (Sensitive: record money received against an invoice with `payments.create`, and charge a saved method or capture or void an authorization; an order you mark paid keeps its gift cards and downloads on a staff review hold, which only staff release), `write_refunds` (Sensitive: `refunds.create`, optionally naming the order lines), `write_themes` (Sensitive: the shared theme draft, never the live theme), `write_navigation` (Sensitive: menus), `write_webhooks` (Sensitive: your own webhook endpoints, see `ctx.api`) and `send_messages_any` (Sensitive on the consent screen) lets `ctx.messaging` email or text any address; ask for it only when the recipients are neither customers, staff nor your own records.
- Buyer contact data is its own tier: `read_customer_names`, `read_customer_emails`, `read_customer_phones` and `read_customer_addresses` (street lines, company, neighbourhood; the city, area and country are always visible). Without one, the matching fields of `ctx.api` responses read `null` (they are marked `x-scalius-protected` in the contract) and provider inputs leave them out. Ask only for what you use: a courier provider must declare names, phones and addresses, an SMS gateway or courier-history checker phones, an email provider emails, a chat provider phones, an address provider addresses (the manifest is refused otherwise); a payment provider receives in `buyer` only the fields its scopes reveal.
- `allowedHosts` (20): hosts `ctx.http` may reach, exact or `*.example.com`. `host:port` names one non-default port. No IP literals or localhost. Empty means no network.
- `events` (40): topics, `<resource>.*` or `*`.
- `functions`: one per declared checkout decision, `{ point, priority, onError, reads }`. Content for buyers is not a function: it is a storefront extension (`storefront.extensions`, Buyer UI below).
- `admin.timeline` (20): `{ kind, title }`, the kinds of order timeline entries the app writes. `admin.settingsGroups` (20): `{ id, title, description?, order? }`, the sections of the app's settings page that `settings[].group` names.
- `objects` (20): named typed entities in the app's namespace (`<plugin id>.<type>`). Each declares fields, optional indexes/uniqueness, display/handle, staff access, public visibility and events. An index (4) or unique set (2) is one field (`"order_id"`) or a list of one to four (`["order_id"]`, `["customer_id", "created_at"]`). Types sync on activation and update.
- `messaging.recipients` (4): `{ object, field }`, `single_line_text` fields of your own objects whose values `ctx.messaging` may email or text by `to`. The field must lead an index or be unique on its own. The consent screen lists them.
- `providers` (24 in all): provider declarations, grouped by port. A regional pack (`plugins/bangladesh`) bundles a country's integrations in one app.
- `routes`: `admin` (40), `public` (20) and `webhooks` (10) entries, each `{ name, methods?, description? }`. `methods` defaults to `["GET"]` for admin and public routes and to `["POST"]` for webhooks.
- `cron` (10): `{ name, schedule }`.
- `jobs` (10): `{ name, title }`, background jobs (see "Background jobs"). Declaring one asks for no access.
- `checkout.attributes` (10): typed buyer inputs scoped as `<app id>.<key>`; up to 8 KiB total on an order.
- `checkout.purchaseOptions` (10): `{ key, title, description? }`, ways to buy a line (a subscription, a rental). A cart line names one as `<app id>.<key>`; one no active app declares is refused (`purchase_option_unavailable`). Core prices nothing for it: your functions do (see "Checkout functions").
- `customFields` (50): fields in the app's namespace on a product, variant, customer, order, category, collection, brand or page. `type` is one of `CUSTOM_FIELD_TYPES` (`@scalius/shared/custom-fields`), checked with the manifest.
- `salesChannels` (3): sales channels the app sells through (`{ id, name }`), Shopify's sales-channel apps. Each becomes the channel `<plugin id>:<id>`, active while the app is. Merchants publish products to it; the app pages them from `GET /api/v1/admin/settings/sales-channels/<channel id>/products` (`products.view`) and follows `product.publication_changed`.
- `features` (24): parts of the app the merchant turns on one at a time (see "Features").
- `settings` (80; 40 for a storefront surface): the merchant's form. Types: `text`, `textarea`, `number`, `boolean`, `select`, `multiselect`, `secret`, `url` (https), `email`, `color`.
- `admin`: `pages` (10), `cards` (20), `actions` (20), `widgets` (5), each naming an admin route; `listColumns` (see "List columns").
- `storefront`: `sections` (32), `components` (16; each names its `targets`: the slots `header.actions`, `footer.columns`, `product.buy_box.before`, `product.buy_box.after`, `product.below`, `product_card.badges`, `product_card.meta`, or `page`), `extensions` (Buyer UI, below), `scripts` (5, https; `pages` is `all`, `home`, `product` or `listing`: app JavaScript never runs on cart, checkout, the receipt or an account page; their hosts join the storefront CSP), `head` and `proxy` flags.
- `limits`: `cpuMs` 5-200 (default 50), `wallMs` 100-30,000 (default 10,000).
- `translations`: text by BCP 47 tag (`bn`, `fr`, `pt-BR`; up to 20) for `name`, `tagline`, `description`, the admin titles and `features.<id>.{name, description}`.

### Listing

These fields describe the app on the Apps page. They give no access, and a change to them needs no new approval. All are optional.

- `icon`: a square SVG or PNG file in the app package, for example `assets/icon.svg`. 64 KiB or less.
- `tagline` (100 characters): one line under the name. Keep it different from `description`.
- `categories` (3): `payments`, `shipping`, `orders`, `inventory`, `returns`, `checkout`, `pricing`, `marketing`, `loyalty`, `store-design`, `content`, `notifications`, `analytics`, `finances`, `support`, `operations`, `compliance`. Put the main one first. The list follows the Shopify App Store subcategories.
- `screenshots` (6): PNG, JPEG or WebP files in the app package, 512 KiB or less each.
- `support`: `{ url?, email? }`. Give at least one.
- `privacyPolicyUrl`, `documentationUrl`, `changelogUrl`: https addresses.
- `countries`: ISO 3166-1 alpha-2 codes, upper case, of the countries the app serves. Leave it out for every country.
- `minPlatformVersion`: the oldest Scalius release the app runs on (semver). A manifest that asks for a newer release than this code does not parse.

Paths are relative to the app package, in lower case, without `..`. The packer reads each file and refuses it when:

- its bytes do not match its type, or it is larger than its limit;
- an SVG has elements other than drawing elements (no `script`, `foreignObject`, `image` or `a`), an `on*` attribute, a reference that is not to its own `#id`, a `url()` to another file, `@import`, a DOCTYPE or an entity.

The packer adds the digests of the images to the end of the bundle as a comment. Thus the bundle SHA-256 changes when only an image changes. The API serves the images to the dashboard at `/api/v1/admin/apps/<id>/assets/<icon | screenshot-N>` on the dashboard origin. It checks each image again, and sends it with `nosniff` and `Content-Security-Policy: sandbox`. An address with the current fingerprint (`?v=`) is cached for one year. A bundled app's images are compiled into the Worker (`assets.gen.ts`). A sandboxed app's images are in R2 at `private/plugins/<id>/<version>/<sha256>/assets/<path>`; `pnpm plugin` writes them to `dist/assets/` beside `dist/plugin.js`.

### Features

An app with several services (a regional pack: payment gateways, couriers, SMS gateways) declares each one as a feature. A feature claims items the manifest declares elsewhere, by name, and adds its own access:

```ts
features: [{
  id: "bkash", name: "bKash", description: "Take bKash payments at checkout.",
  providers: ["bkash"],                       // its fields (group: "bkash") go with it
  allowedHosts: ["tokenized.pay.bka.sh"],     // beyond the app's own allowedHosts
  scopes: [],                                 // beyond the app's own scopes
  // also: settingsGroups, routes { admin, public, webhooks }, cron, events, functions,
  // admin (page, card, action, widget ids), storefront { sections, components, skins, extensions }
  recommended: false,                         // a setup screen may tick it; it still starts off
}]
```

- Every feature starts **off**. What no feature claims is the app's base and runs whenever the app runs. The top-level `scopes` and `allowedHosts` are the base; the consent screen shows the union with each feature's part beside it.
- Turning a feature on asks a Super Admin to approve **that feature's** scopes and hosts only (`dashboard.apps.feature_enable`, a person's step, never an agent's). Turning it off revokes them at once (`dashboard.apps.feature_disable`; agents may). `dashboard.apps.features_list` lists them with their state and request.
- An off feature costs nothing: its providers, routes, cron jobs, event subscriptions and functions are not registered, its settings are hidden and not in `ctx.settings`, and its scopes and hosts are not granted. Its handlers must still be in the module; the runtime refuses to run them. Its saved settings stay for when it is turned on again.
- `ctx.features` lists the features that are on; use it to leave an off feature's parts out of a shared screen.
- `lifecycle.enable(ctx, { feature })` runs after a feature is turned on, with its access; `lifecycle.disable(ctx, { feature })` runs before it is turned off, while it still has it.
- An item belongs to at most one feature, and may point only at items of its own feature or of the base (an admin page at its feature's route, a provider at its feature's settings).
- An update keeps the features that are on and starts new ones off. It needs approval again when an on feature (or the base) asks for more.
- `createPluginTestHarness(module, { features })` runs with those features on (default: all).

Activation shows a Super Admin everything the manifest asks for. An update that asks for more access stays inactive until a Super Admin approves it.

A `secret` setting is encrypted with a key derived from `CREDENTIAL_ENCRYPTION_KEY` and masked everywhere. It appears decrypted only in `ctx.settings`. A secret that cannot be opened reads as `null`.

## Handlers

Definition keys match the manifest. The host rejects an undeclared handler, and a declared item without one, when the app is packed and when it loads.

- `events["order.paid"]`, `["order.*"]`, `["*"]`: `(event, ctx)`.
- `functions["checkout.discounts"]`: `(input, settings)`. Pure, no `ctx`.
- `routes.admin.<name>`, `routes.public.<name>`, `routes.webhooks.<name>`: `(request, ctx) => { status?, headers?, body? }`.
- `cron.<name>`: `(ctx, { name, scheduledAt })`.
- `jobs.<name>`: `(ctx, { id, name, input, state, step })` => `{ state?, progress?, message?, done? }`.
- `providers.<id>`: `definePaymentProvider`, `defineCourierProvider`, `defineSmsProvider`, `defineEmailProvider`, `defineCourierHistoryProvider`, `defineTaxProvider`, `defineTranslationProvider`, `defineAiProvider`, `defineMessagingProvider`, `definePushProvider`, `defineSearchProvider`, `defineAddressProvider`, `defineFxProvider` or `defineIdentityProvider`.
- `lifecycle.install`, `activate`, `deactivate`, `uninstall`, `enable`, `disable`: `(ctx)`. `uninstall` also gets `{ keepData }`; `enable` and `disable` get `{ feature }`. No declaration needed.
- `migrations["1"]`, `["2"]`: `(ctx)`. One for each `manifest.migrations[].version` (see "Data updates").

**Events.** `EVENT_TOPICS` in `packages/shared/src/events.ts` lists the versioned topics, including order, inventory, customer, fulfillment, shipment, payment, discount, review, gift-card and object events. Reserved privacy-request names have no emitter until their core flow exists. The catalogue changes only by addition. An event carries ids, states and quantities, never contact data or money. Read the resource with `ctx.api`. Fulfilment and refund events (`order.fulfilled`, `fulfillment.created`, `fulfillment.voided`, `refund.created`, `refund.updated`) also list the order lines they cover, `lines: [{ orderItemId, variantId, quantity }]` (at most 500), so a handler can move units without a read; a refund's status is `pending`, then `refunded`, `failed` or `partial`.

- Delivery is at least once. `event.id` is stable across attempts: use it as your idempotency key.
- A handler that throws or times out is retried after 1 min, 5 min, 30 min, 1 h, 3 h, 6 h and 12 h. After 8 attempts the delivery is exhausted and the merchant can retry it from the app's page.
- An app gets only events after its activation, including those its own writes cause. Write only when something changes, so the handler converges.

**Cron.** A schedule has five fields and runs in the store's time zone (`Asia/Dhaka`). The API checks schedules every 15 minutes on Workers Paid and every 23 minutes on Free. A slot runs once and never overlaps the job's previous run. After downtime only the latest missed slot runs (within 24 hours). Use `scheduledAt`, not the clock, for time windows.

## `ctx`

- `features`: the app's features that are on.
- `plugin`, `store`, `settings`: app id and version; store `name`, `url` (null until the merchant sets Settings > Store details > Web addresses), `currency`, `decimalPlaces`, `timezone`, `locale`; the installation's settings with secrets decrypted.
- `api.call(operation, input)`: calls a stable app-API operation by its app name, the resource and the verb (`orders.get`, `products.create`, `objects.upsert`), with the dashboard's validation, the scopes' RBAC and audit. Each operation has exactly one app name (`stableContract.operations` lists them); a dashboard operation id such as `orders.get` is unknown to apps (`api_unknown_operation`, whose message names the app name). Stable operations carry `x-scalius-agent.stability: "stable"` in the OpenAPI contract; their schemas change only additively. Resource reads (`orders.get`, `products.get`, ...) return the same representation a webhook carries, and money is integer minor units beside its `currency`. The tier covers orders (`orders.create` pays by `cod` or an invoice due in `paymentTerms.days`; `payments.create` records money received), products (`products.create` with options and SKUs at stock 0, `products.update` under `expectedRevision`), refunds (`refunds.create` under `write_refunds`, optionally naming order lines; `refunds.list`), payments on saved methods (`payments.charge`, `payments.capture`, `payments.void`, `payment_methods.list` and `payment_methods.delete`, under `write_payments`), gift cards (`gift_cards.*`) and your own webhook endpoints (`webhook_subscriptions.*`, at most 5, only on your approved hosts, topics and customer data; the signing secret is returned once). Any other operation refuses with `api_operation_not_stable` (bundled first-party apps may also call `beta` ones by their app name). Returns `{ ok, status, data, error }`. Every stable mutation takes one retry key, `idempotencyKey` (sent as the `Idempotency-Key` header, 8-200 printable characters): a repeat within 24 hours returns the first result, and the same key for a different request is refused (`idempotency_key_reused`). No request body carries a key. Stock moves (`x-scalius-agent.idempotency: required`) need one. Updates take the revision you read (`expectedRevision`, `expectedVersion` or `expectedStockVersion`) and refuse with 409 when it changed. 60 calls a minute. Every list takes `cursor` and `limit` and answers `{ <plural>, nextCursor }`; every instant is an ISO 8601 date-time string; every error code is lower_snake (`price_changed`, `api_operation_not_stable`).
- Setting up a store (a theme's onboarding, a demo pack; the `acme.builder` test app does all of it):
  - `categories.batch_create`, `brands.batch_create` and `products.batch_create` take `{ items }`, each the single create's body plus your `key`, in minor units (the bound is a plan value: on Free 12 categories, 19 brands or 4 products a call). Each item answers `created`, `replayed` or `failed`. An item's id derives from its key, so repeating a key creates nothing again, whatever the request's `idempotencyKey`.
  - Collections have a handle (`slug` on `collections.create`/`update`; omitted, it reads as the name).
  - `theme.get`, `theme.apply_template` and `theme.set_section_settings` (Sensitive `write_themes`) change the shared theme draft under `expectedDraftRevision` and `basePublishedRevision`, never the live theme: staff publish. An app applies only its own templates, and the draft it replaces is kept as a restore point.
  - Templates, page presets and section settings may name catalogue content by handle: `@category:<handle>` and `@collection:<handle>` in id lists, `{ "kind": "collection", "handle": "hot-deals" }` as a product source, `/collections/@<handle>` as a link. Handles resolve when the template is applied or listed; a homepage section naming a handle the store lacks is left out and reported (`unresolved`).
  - `menus.get`, `menus.create` and `menus.update` (Sensitive `write_navigation`) write a menu and all its links (a flat list in tree order, `parentKey`, three levels, 150 links; a category or collection link may name a handle) under `expectedRevision`, and publish it with `publish: true`. A refused publish answers `published: false` with `publishError` and keeps the links saved. Where a menu shows (header, footer) stays the merchant's choice.
- `http.fetch(url, init)`: https only, to `allowedHosts`. Each redirect hop (at most 5) is checked again. Request and response are at most 1 MiB. `timeoutMs` is 1-30,000 (default 10,000). 60 requests a minute. `Set-Cookie` is dropped.
- `customFields` (`get`, `set`): values of the app's own declared fields on one resource. The approved grant must cover the owner type. One lane per owner: your fields go through `ctx.customFields`, the merchant's (`custom` namespace) through `ctx.api.call("custom_fields.get_<owner>_values")` and `set_<owner>_values`, which never show an app another app's fields.
- `messaging`: `email`, `sms` and `pushCustomer` through the store's providers, and `notifyStaff` (Firebase devices and Web Push browsers). An email or SMS goes to a `customerId` (needs `read_customers`; the platform resolves the address and never returns it) or a `to` that is a staff member's email or an address one of your `messaging.recipients` fields holds, exactly as the record holds it. Any other `to` needs `send_messages_any`, or it fails with `messaging_recipient_not_allowed`. `pushCustomer({ customerId, title, body?, url?, tag? })` (needs `read_customers`) reaches the browsers the buyer subscribed on the account page (or the store's push app); `url` is a store path. With `marketing: true` (needs `write_marketing`) and a `customerId`, only a subscribed customer gets an email or SMS, with the unsubscribe footer. A subject is at most 200 characters, HTML 100 KiB and text 50 KiB (UTF-8), an SMS 1,000 characters (`PLUGIN_MESSAGE_LIMITS`); the plan's `messagesPerMinute` (60 on Free, 300 on Paid) counts every send. The test harness takes the store's staff addresses as `staff`.
- `timeline.add({ orderId, kind, message, fields?, idempotencyKey? })`: the one way an app writes on an order timeline, a line with your app's name (needs `write_orders` and a kind declared in `admin.timeline`). Staff notes (`orders.comment_add`) are the dashboard's, not part of the app API. `message` is plain text (500 characters), `fields` at most 10. The same `idempotencyKey` adds it once.
- `orders`: actions on a placed order, for event handlers. `riskHistory(orderId)` (needs `read_orders`) gives the buyer's earlier orders as counts `{ orders, cancelled, returnedToSender }`. `assessRisk({ orderId, level, reasons })` (needs `write_orders`) records your advice on the order's customer card (`low | medium | high`, up to five reasons of 200 characters). `hold({ orderId, reason })` (needs `write_orders`) holds the order for staff review: it is not shipped, handed over or moved on until staff release it; cancelling stays possible and nothing is cancelled automatically. Each is once per order and app, so a redelivered event changes nothing.
- `customers.roles` (needs `read_customers`): roles your app gives customers. `grant(customerId, role, { ref? })` gives one (`role` is a lower-case letter, then up to 31 letters, digits, `_` or `-`; `ref` is your own record id, 1-128 printable characters); granting it again only changes `ref`. `revoke(customerId, role)` takes it away (idempotent); `list(customerId)` answers `[{ role, ref, grantedAt }]`. Each app reads and writes only its own roles, at most 10 per customer (`customer_roles_limit`); a missing or deleted customer is refused (`customers_not_found`). Proxied requests carry them as `request.customer.roles` and checkout functions as `cart.customer.roles`, so a seller portal or a members-only price gates on a role without a read of its own. Uninstalling without keeping the data deletes them.
- `jobs`: background jobs (see "Background jobs"): `start(name, { input?, key? })`, `get(id)`, `list({ name?, limit? })`, `cancel(id)`.
- `log`: `debug`, `info`, `warn`, `error`. The platform keeps the newest 500 lines per app and masks secrets, e-mail addresses and phone numbers.
- `objects`, `kv`: see Objects and private cache.

A refusal throws an error with a stable `code` (`object_conflict`, `http_not_allowed`, `rate_limited`). Read it as `(error as { code?: string }).code`.

## Objects and private cache

`ctx.objects.<type>` holds records validated against the type's declared fields. A record is at most 64 KiB and its id is 1-128 printable characters. A query uses declared indexes only: equality on the leading fields of one index, ordering by its next field. A unique set also answers an exact lookup on all its fields (every value given), with no index of its own. `limit` is at most 100 (default 50).

Every write advances the record's **revision** (`object_records.revision`). Conditional write:

```ts
const current = await ctx.objects.balances.getVersion(customerId); // { data, revision } | null
await ctx.objects.balances.put(customerId, next, { expectedRevision: current?.revision ?? null });
// A write landed since (or the record exists when null was expected): `object_conflict`, nothing changed.
```

- `update(id, patch, { expectedRevision? })` merges top-level fields. Without a pinned revision it re-reads and merges again, so no update is lost.
- `increment(id, field, delta, { min?, max? })` adds to a whole-number field. A result outside the bounds fails with `object_out_of_range` and changes nothing. A money field is not a whole number: `update` it with the new amount.
- `ctx.objects.batch([...])` writes up to 25 `put`, `delete` and `check` operations across object types, all or nothing. Each may carry `expectedRevision`. A batch writes each record once.
- A unique index violation fails with `object_unique_violation`.

### Money

Money crosses every app boundary in one format: integer minor units plus an ISO 4217 code. Resource reads, webhooks, functions and ports carry `*Minor` fields beside a `currency` field. A `money` field of an object or a custom field holds `PluginMoney`, `{ amountMinor, currency }`, in the store currency (`ctx.store.currency`). A `list.money` field holds an array of them. `ctx.objects`, `ctx.customFields`, declared function reads and the HTTP API (`objects.*`, `dashboard.custom_fields.*`) all read and write this one shape:

```ts
// 1,250 taka in a BDT store (2 decimal places)
await ctx.objects.wallets!.put(customerId, { balance: { amountMinor: 125000, currency: ctx.store.currency } });
const wallet = await ctx.objects.wallets!.get(customerId); // { balance: { amountMinor: 125000, currency: "BDT" } }
```

A write refuses (`object_invalid`) a decimal, a bare number, another currency, a negative or fractional `amountMinor`, and an amount off the store's price increment. Validation bounds (`min`, `max`) on a money field are integer minor units of the store currency. A `where` filter on a money field takes the `PluginMoney` you read or its `amountMinor`; on the HTTP API, `where[price]=125000`. The storefront contract (sections, components, skins and islands) adds the store's text: `StorefrontMoney` is `{ amountMinor, currency, formatted }`, and `formatMoney(context, money)` takes either shape.

`ctx.kv` is a key/value store with TTLs (value 64 KiB, key 256 characters, TTL at most one year, `list(prefix)` at most 1,000 keys). `getVersion` and `compareAndSet(key, expectedRevision | null, value)` give the same compare-and-set (`kv_conflict`). `batch` is a reserved object name. Private caches are never exposed as content to staff or the storefront.

## Checkout functions

A function is pure: `(input, settings) => output`, with no I/O. The host stops it after the smaller of `limits.wallMs` and 1.5 s, validates the output and merges it (schemas: `@scalius/shared/plugins/functions`). Points, in checkout order: `cart.transform`, `cart.line_prices`, `cart.validate`, `checkout.discounts`, `checkout.shipping_rates`, `checkout.payment_methods`. They run for the online store and buyer agents; staff orders run all but `cart.transform` and `cart.line_prices` (staff set lines and prices). `cart.customer.tags` lists the signed-in customer's tags, and `cart.customer.roles` the roles your app gave them (`ctx.customers.roles`; each app sees only its own). `cart.market` is `{ id, country }`: the market the order is placed in and the country that chose it (null before an address is known). `cart.salesChannelId` is the channel the order sells from, `cart.customer.segmentIds` the segments of the market's live segment price lists the buyer is priced by (at most 50), and each line carries `requiresShipping`, `weightGrams` (null when unset) and `purchaseOption`. `cart.attributes` holds accepted values of the active apps' declared checkout attributes by `<app id>.<key>`. `checkout.payment_methods` hides, renames and reorders the methods checkout allows; a method marked `gated: true` (the store's invoice, when the merchant lets apps decide who pays later, or your own deferred payment method) is offered to this buyer only if an app answers `{ op: "allow", methodId }` (for an app's deferred method, only that app), and a hide wins over an allow.

Which seam: a decision inside a request is a function; a provider of a capability is a port (`providers`); a reaction after the order commits is an event handler. Order risk is the last kind: handle `order.created` and call `ctx.orders`.

- **`cart.transform`** answers `{ operations: [{ expand: { lineId, title?, components: [{ variantId, quantity }] } } | { merge: { lineIds, title } }] }`. A bundle's components become real order lines (stock, tax and refunds per SKU); the buyer sees one line at their summed price. Lines with buyer inputs, gift cards and carts above 99 lines are never changed.
- **`cart.line_prices`** answers `{ prices: [{ lineId, unitPriceMinor }], adjustments: [{ lineId, amountMinor, title }] }` (both optional).
  - `prices` are B2B, tiered or member prices. A price applies only when no price list does: sale > segment > market list > your price > FX > base. The first app by priority wins a line.
  - `adjustments` are add-ons to each unit (an engraving's letters, a gift wrap), applied after that whole precedence, so discounted, sale and price-listed lines take them too. Every app's add-ons apply, at most five per line, each in the cart currency and rounded half-up to the market's price increment. Gift cards and bundle lines take none. The buyer sees each as "Add-on: <title> (+price)" in the cart, checkout, receipt and emails. Tax, discounts, totals and refunds include it.
- **Declared reads** (every point, and every storefront extension). A function reads the app's own data through the manifest, never through I/O. Up to four reads per function (and four across an app's extensions):

  ```ts
  { point: "cart.validate", onError: "block", reads: [
    { as: "member",  object: "members",   key: "customer" },                    // record id = the buyer's id
    { as: "company", object: "companies", key: { from: "member.company_id" } },   // one hop from a single-key read
    { as: "moq",     object: "moq",       key: "line.variantId", max: 50 },       // one record per cart SKU
    { as: "fields",  customFields: ["product:min_qty"], max: 48 },                // your own fields on the cart's products
  ] }
  ```

  - Keys: `customer`, `line.variantId`, `line.productId`, `attribute.<key>` (the buyer's value of one of your checkout attributes), or `{ from: "<as>.<field>" }`, the id held in a `single_line_text` or `object_reference` field of an earlier single-key read. A custom-field read names fields of one owner type (`product`, `variant` or `customer`) and is keyed by it.
  - `input.reads[as]` is `{ revision, data } | null` for a single key and `Record<key, { revision, data }>` (records that exist) per line; `readOne(reads, as)` and `readMany(reads, as)` read them typed. Custom-field records have revision 0. Data is in the SDK's wire form, as `ctx.objects` reads it (money as `{ amountMinor, currency }`).
  - Bounds: at most 100 keys asked per function (a single key counts one; a per-line read its distinct SKUs or products, at most its `max`) and 256 KiB of resolved JSON. A function over a bound does not run, which `onError` treats as a failure.
  - Cost: the reads ride the checkout's own read batch (one statement per object type, hop and custom-field group), so they add statements but never a round trip or wave.

- **Failure policy.** A function that throws, times out or answers invalidly is left out (`onError: "skip"`). Only `cart.transform`, `cart.line_prices`, `cart.validate` and `checkout.payment_methods` may use `onError: "block"`. Checkout then stops with the store's buyer-safe text (Settings > Checkout, "Apps at checkout").
- **Commit** (`checkout.discounts`). The answer may carry `commit: [{ as, record }]`: the next version of records this function read (single-key object reads whose key resolved to an id; a missing record is created). The platform writes them in the order's own commit batch, each at the revision you saw, and only when one of your discounts applied.
  - If the record changed meanwhile, the order fails with `app_offer_changed` and the buyer reviews it.
  - Size the discount against `cart.lines[].lineTotalMinor`. A discount's class follows its target (`lines` is a product discount; `order`; `shipping`) and it may declare `combinesWith: { productDiscounts?, orderDiscounts?, shippingDiscounts? }` (each defaults to true). It applies only if it and every discount already applied, the platform's included, combine with each other's class; a skipped one claims no code and commits nothing. The test app `apps/api/src/plugins/testing/apps/loyalty` is a worked example.
- **Purchase options.** A line bought under your option (`checkout.purchaseOptions`, `<app id>.<key>`) is a line of its own: the same SKU one-time or under the option are two lines. Your functions see `line.purchaseOption` and price it (`cart.line_prices`, `checkout.discounts`) or check eligibility (`cart.validate`); the order line freezes it as `_purchase_option` and the order representation carries `purchaseOption`. Core runs no subscription logic: a renewal is your `orders.create` plus `payments.charge` on the saved method (the `acme.subscriptions` fixture).
- **Holds** are not a function: handle `order.created` and call `ctx.orders.hold` (see `ctx`). The test app `apps/api/src/plugins/testing/apps/risk-guard` is a worked example.

## Routes and storefront surfaces

| Surface | URL | Access | Body limit |
| --- | --- | --- | --- |
| `admin` | `/api/v1/plugins/<id>/admin/<name>` | Dashboard session. `apps.view` reads; `apps.use` also changes. | 1 MiB |
| `public` | `/api/v1/plugins/<id>/public/<name>` | None. 60 requests a minute per client and app. | 256 KiB |
| `webhooks` | `/api/v1/plugins/<id>/webhooks/<name>` | None. `POST` unless the route's `methods` say otherwise (a provider's `GET` check: `["GET", "POST"]`). 60 requests a minute per client and route. `rawBody` holds the exact body for signature checks. | 1 MiB |

- Only active apps answer, and only declared routes and methods. Cookies never reach a handler. Admin and public handlers see only `accept`, `accept-language`, `content-type`, `if-none-match`, `user-agent` and `x-requested-with`. Webhook handlers see every header except credentials and network headers.
- Responses are JSON. An app cannot set cookies, CSP, CORS, `content-type` or redirect headers. A public or webhook response is `no-store` unless it sets exactly `cache-control: public, max-age=N` with N at most 300.
- Admin pages, cards and widgets answer with `ui.page(...)` or `ui.view(...)`, and buttons and forms with `ui.result(...)`. `adminContext(request)` reads the request, including the dashboard language.
- Private buyer pages use storefront extensions (below); public routes never draw cached static checkout/account HTML.
- With `storefront.proxy`, `/apps/<id>/*` on the storefront reaches the public routes. `request.customer` holds the signed-in customer's id and the roles your app gave them (`roles: [{ role, ref }]`), never a cookie. Answer `{ page }` or `{ redirect }` for a page navigation.

## Background jobs

An admin action that one run cannot finish (an import of 500 products is far more than 50 platform calls) is a job. Declare it (`jobs: [{ name: "import_products", title: "Import products" }]`), start it from a button's route with `ctx.jobs.start("import_products", { input, key })` and answer at once. The platform keeps the job and runs `jobs.import_products(ctx, job)` one step at a time: right after that response, then every minute, the plan's `bulkRunChunksPerDrain` steps per drain (3 on Free, 12 on Paid). Each step is a run of its own with the run limits below.

- A step gets `{ id, name, input, state, step }` and answers `{ state?, progress?: { done, total }, message?, done? }`. `state` (64 KiB of JSON) goes to the next step; left out, the state stays. `done: true` finishes the job. `message` (200 characters) is shown to staff: never put buyer contact data in it.
- A step commits with a compare-and-set on the step counter: a crash between steps repeats at most that step, never commits it twice. Make each step safe to run again (derive idempotency keys from `job.id` and `job.step`).
- A step that throws, times out or answers something invalid is tried again a minute later, three attempts in all, then the job fails with `job_step_failed` or `job_invalid_step`. Turning the app off or uninstalling it fails its running jobs with `app_inactive`.
- `start` takes `input` (16 KiB of JSON) and `key` (8-200 printable characters): a second start under the same key answers the first job (`jobs_key_reused` for another input). An app runs at most `runningJobs` jobs at once (3 on Free, 10 on Paid; `jobs_limit`). `get(id)` and `list()` answer `{ id, name, status: running | done | failed, progress, message, error, steps, createdAt, updatedAt, finishedAt }` for the app's own jobs only; `cancel(id)` fails a running job with `cancelled`.
- Show it on the app's page with `ui.progress(label, job.progress.done, job.progress.total, { live: job.status === "running" })`. While a live progress is on screen the dashboard reads the page again every 3 seconds (for at most 10 minutes).
- Jobs never appear among the store's bulk runs (`bulk_runs.get`, `bulk_runs.list`). Uninstalling without keeping the data deletes them.

## Buyer UI

Declare one storefront extension per UI slot, `storefront: { extensions: [{ target: "checkout.contact.after", reads }] }`, and implement `extensions["checkout.contact.after"]` as a pure render returning `{ ui: ui.view([...]) }` (or `{ ui: null }`): the same `ui` tree and `ui.*` builder as admin pages, held to the buyer surface (`stack`, `columns`, `heading`, `text`, `badge`, `banner`, `divider`, `key-value`, `image`, `link`, `field` and `button`). Targets are UI slots: on the cart page `checkout.contact.after`, `checkout.delivery.after`, `cart.page.summary` and `cart.page.below` (under its lines and summary); on the payment step `checkout.payment.after`, `checkout.actions.before` and `checkout.summary.after` (under its order summary); `cart_drawer.footer` (the cart drawer on every page, above its checkout button); `order.confirmation`, `account.order`, `account.overview`, `account.profile`. Fields are editable only in the checkout slots, where checkout checks the answer; buttons run cart operations (`ui.cart.*`) there and in the cart drawer, which shows a field's current answer read-only (ask in a checkout slot); order and account slots are read-only. A failed render is omitted; it cannot block checkout. Extensions are not functions: they have no priority or `onError`, and the consent screen lists them under the storefront. Test one with `harness.extension(input)`.

A field (`ui.field(key)`) names a key in `checkout.attributes`; core owns the input, validation and storage. Buttons take one action union: `ui.cart.addLine`, `ui.cart.setAttribute`, `ui.cart.applyCode` (cart and checkout slots), `ui.route(name)` (a declared public route) or `ui.navigate(ui.to.store(path))`. Images use store media or this app's sealed public files; links use same-store paths. No app HTML or JavaScript reaches private buyer pages.

The input includes the target, language, locale, currency, relevant cart/order/customer ids, accepted attributes, and the reads that slot's extension declares (keyed by the buyer, the cart's or order's lines, or an attribute). UI travels with cart validation, tax quote, receipt and account responses. Attributes enter the quote fingerprint and existing order insert, never URLs or events. See the `notes` and `loyalty` fixtures for working examples.

## Storefront components

An app can redesign the storefront without a fork: component sections, the header, footer and product card, ready-made templates, client islands and a stylesheet, compiled once by `pnpm plugin pack` and run at the edge as a pure function of the page's data. A paid store uploads and activates the app; a free store bundles it with `pnpm plugin add`. Component sections can place the store's own order form (`<OrderForm product={...} />`) for single-page order landings. [docs/STOREFRONT-COMPONENTS.md](../../docs/STOREFRONT-COMPONENTS.md) is the guide; `plugins/noor` is a complete theme and `apps/api/src/plugins/testing/apps/studio` a small example. Core section types, skin units and embed kinds are snake_case (`usp_strip`, `product_card`, `buy_form`; theme document v12), and `StorefrontMoney` is `{ amountMinor, currency, formatted }`. Publishing a theme that draws with parts of an app that is inactive or no longer declares them is refused (`theme_apps_unavailable`, naming each app and its parts), and deactivating or uninstalling an app lists the live parts that would fall back to the store's design.

## Providers

An app can fill a **port**, the typed interface the platform's own adapters implement (`@scalius/shared/plugins/providers`). A provider's store id is `<plugin id>:<provider id>`. Declare providers in the manifest by port and implement each with the matching `define*Provider`.

Ports have a tier (`PROVIDER_PORT_TIERS`). `payment`, `courier`, `sms` and `courier_history` are **stable**: real providers implement them, and their schemas change only additively within the plugin API version. `email`, `tax`, `translation`, `ai`, `messaging`, `push`, `search`, `address`, `fx` and `identity` are **beta** until a real provider proves them: you may implement them, the consent screen labels them Beta, and their schemas may still change. A port is promoted by changing its tier, never demoted.

Each port has required operations, and optional ones that you list in `operations` (`PROVIDER_OPERATIONS` in `@scalius/shared/plugins/providers`). Required: `payment` needs `createSession` and `verifyWebhook`, `courier` needs `createShipment` and `trackShipment`, `sms`, `email`, `messaging` and `push` need `send`, `courier_history` needs `check`, `tax` needs `calculate`, `translation` needs `translate`, `ai` needs `generate`, `search` needs `search`, `address` needs `suggest` and `resolve`, `fx` needs `rates`, and `identity` needs `authorize` and `exchange`. The host dispatches only operations supported and declared by that port. Checkout calls courier `rates` for calculated shipping methods and tax `calculate` when configured; a provider failure follows its explicit fallback policy or fails checkout closed. The merchant picks a provider in Settings > Payments, Shipping and delivery, Notifications (SMS and email) or Integrations (fraud).

The host validates every input and output on both sides. A provider runs only when it is ready: the app is active, approved for the port and runnable here, with complete settings and readable secrets. The dashboard shows readiness and, if you declare `testConnection`, a connection test. A setting named `environment` with the values `sandbox` or `live` marks the provider as test or live.

An app with several providers names each provider's own settings: `{ id, name, settings: ["gateway_token", "gateway_sender"] }`. Those keys need not be `required` for the whole app. The provider is ready only when each one is set, readable and not an obvious placeholder ("test", "your api key"), and a save refuses such a placeholder. Only the provider's own unreadable secrets block it, so one gateway's broken key never stops another (`plugins/bangladesh`).

A provider operation's `ctx.http` calls to its provider do not count against the app's outbound limit: the platform paces the operations it calls.

Fail with `ProviderError(category, message, { uncertain?, code? })`:

- `declined`: the provider refused and nothing happened. The platform shows it and does not retry.
- `retryable`: try again later. Add `uncertain: true` if the call may have reached the provider. The platform retries or reconciles, and never repeats an uncertain call blindly.
- `misconfigured`: credentials or settings are wrong. The provider is not ready and the platform fails closed.

A throw that is not a `ProviderError`, a timeout or an invalid answer counts as `retryable` and `uncertain`. A message is at most 300 characters and must be safe for a merchant: never a credential, a raw provider body or buyer contact data. `ctx.messaging` is refused inside a provider operation: reach your provider with `ctx.http`.

### Build a payment provider

Declare `{ id, name, checkoutName?, flow: "hosted", chargeCurrencies, operations }` under `providers.payment`, plus optional `amountLimits: { currency, minMinor, maxMinor }` and `amountCodecs: { BDT: { wireExponent: 2 } }`. `hosted` redirects to the provider. `deferred` charges nothing at checkout: declare `dueInDays` (1 to 365) and the order is placed unpaid with that due date, its stock reserved; it is offered only to signed-in buyers, and only when your own `checkout.payment_methods` answers `{ op: "allow", methodId }` for that buyer (declare the function: a manifest with a deferred provider and none is refused). If your function fails or times out, the method stays hidden. Its payments arrive as your provider's verified events or are recorded with `payments.create` (scope `write_payments`). `chargeCurrencies` is a list such as `["BDT"]`, or `"any"`. Optional `countries` (default `"any"`) lists the shipping countries the method serves; checkout never offers it for a delivery to another country.

A hosted provider must declare `verifyReturn` and `queryPayment`. A provider that declares `refund` must declare `refundStatus`, and may add `listRefunds` to import refunds made in the provider's dashboard. For each session the platform builds the return URLs `/api/v1/payment/<provider id>/success|fail|cancel` and the webhook URL `/api/v1/webhooks/<provider id>`. `input.urls` holds them.

1. **`createSession(input, ctx)`** returns `{ providerRef, redirectUrl }` (https only).
   - `input.attemptKey` is your idempotency key. A retry of the same attempt must return the same provider session, so store it.
   - `input.correlationId` (at most 30 characters) is the merchant reference. The provider must echo it.
   - `input.wireAmount` (`{ minor, decimal }`) is the amount in your declared wire form. The platform refuses a charge your codec cannot carry exactly.
2. **`verifyReturn` and `verifyWebhook(request, ctx)`** authenticate before anything changes: check a signature, or ask the provider server to server for the reference the request names. A query string is never authority. Answer `{ status: "event", event }`, `"ignored"`, `"invalid"` (forged: nothing changes) or `"retry"` (the provider could not be asked now).
   - A confirmed event carries the provider-authenticated `amountMinor` and `currency`.
   - A webhook and a return for the same capture must give the same `eventType` and `eventId`, so the platform applies it once.
   - Failed and cancelled events carry `correlationId`, so the platform releases the right attempt.
3. **`queryPayment`** answers "did it go through?" for a buyer or a staff reconcile: `{ providerStatus, event? }`.
4. **`refund`** runs at most once per `input.idempotencyKey`. Store what you sent. If the answer is lost, raise `retryable` with `uncertain`: the platform then asks `refundStatus` instead of refunding twice.

Saved methods and authorizations (subscriptions, "authorize at order, capture at ship") are two optional capabilities, each declared with its operations: `capabilities: ["vault"]` with `chargeSavedMethod` and `deleteSavedMethod`, `capabilities: ["manualCapture"]` with `capture` and `void`. The store keeps only your reference to a saved method and its display facts; never send a card number or CVC.

5. **Keeping a method.** A session for a signed-in account customer may carry `input.savePaymentMethod: { customerId, usage: "off_session" }`. Your confirmed (or authorized) event then names the kept method: `savedPaymentMethod: { ref, brand?, last4?, expiryMonth?, expiryYear?, label? }`. The store saves it for that customer with the payment.
6. **`chargeSavedMethod({ attemptKey, correlationId, orderId, paymentType, amountMinor, currency, wireAmount, methodRef, capture, requestTimeoutMs })`** charges a kept method without the buyer. `attemptKey` is your provider idempotency key: a retry after a lost answer sends the same key and must get the first outcome. Answer `{ status: "event", event }` (`confirmed`, or `authorized` when `capture` is `"manual"`), `{ status: "pending" }` (a verified webhook follows) or `{ status: "declined", reason, code? }`. No answer is `retryable` with `uncertain`.
7. **`capture({ providerRef, amountMinor, … })`** answers the `confirmed` event under the authorization's `providerRef`; **`void({ providerRef, … })`** answers `{ status: "voided" }`. Both take an `idempotencyKey`. A provider-side expiry of a hold is a verified `cancelled` event naming its `providerRef`.
8. **`deleteSavedMethod({ ref, idempotencyKey })`** detaches the method at the provider: `{ status: "deleted" }` or `"not_found"`.

### Build a courier

Declare `{ id, name, countries?, trackingUrl?, locations?, icon?, settings?, operations }` under `providers.courier`. The Bangladesh pack's Pathao and Steadfast (`plugins/bangladesh/src/couriers.ts`) are complete examples.

- `trackingUrl` is an https template that contains `{trackingId}`, such as `https://track.acme.example/{trackingId}`. The platform saves the page with each shipment.
- `locations: { key, required, numeric }`: your courier books by its own location ids, kept on the store's places under `externalIds.<key>` (your app may load them with the place import). The platform refuses a booking whose city, zone or area lacks a `required` id before it writes anything, and passes the ids as `recipient.locationIds`.
- `icon` is your courier's own mark in the package (SVG or PNG, the app icon's checks). The dashboard shows it beside the courier; without it, the app's icon.

1. **`createShipment(input, ctx)`.** The platform inserts its own shipment row first and passes its id as `input.idempotencyKey`. A retry after a lost answer reuses it, so book at most once per key.
   - `codAmountMinor` is the cash to collect (0 for prepaid), in minor units of `currency`.
   - Return `externalId`, `trackingId`, a normalized `status`, your `rawStatus`, the quoted `chargeMinor`, an optional label (https URL, or a base64 PDF the platform stores privately) and flat `details` for staff.
   - If the call may have reached the courier but you got no answer, raise `retryable` with `uncertain`. With `findShipment` (by order number) the platform then finds the booking instead of booking twice.
2. **`trackShipment`** maps your courier's status onto `COURIER_SHIPMENT_STATUSES` with an ISO timestamp. The platform moves the order from it.
3. **`verifyWebhook`** authenticates a tracking push to `POST /api/v1/webhooks/couriers/<plugin id>:<provider id>`, the URL the merchant copies into the courier's settings. You get every header (with `authorization`) and the exact body. Answer:
   - `{ status: "update", externalId, tracking, eventId?, orderId? }`: a new state. With `orderId` (the order number the courier echoes) the platform refuses a booking of another order and binds a booking `findShipment` confirmed without its id.
   - `{ status: "note", externalId, eventId, details, orderId? }`: facts (a tracking message) without a state change.
   - `"ignored"` (authentic, about no shipment: an integration check) or `"invalid"` (401; with `rejectStatus` 4xx for an authentic but malformed push).
   - Any accepted answer may carry `reply: { status (2xx), headers?, body? }`, what your courier expects back (Pathao checks a 202 and a secret header). The platform keeps it JSON, uncached and without cookies.
   - Raise `misconfigured` when your secret is not set: the platform answers 503 and the courier sends again later.

   The platform applies each push once (by `eventId` when you send one). It accepts a push only when exactly one active delivery provider uses your courier.

### SMS, email and courier history

- **SMS and email.** Implement `send`. Every send port uses the same names: `to` (the recipient), `text` (plain text) and `idempotencyKey`; SMS is `send({ to, text, idempotencyKey? })`, email adds `subject` and `html`. Never send twice for one `idempotencyKey`. Answer `{ success, providerRef?, rawStatus?, retryable? }`. Set `retryable: false` for errors a retry cannot fix.
- **Courier history.** Implement `check({ phone, orderId? })`: the parcels courier networks booked, delivered and cancelled for the phone. The merchant reads the answer on the order page as advice. It never blocks automatically. An app that must stop fulfilment handles `order.created` and calls `ctx.orders.hold`. A general order-risk port (`risk`) is planned as beta; until then `ctx.orders.assessRisk` records an app's risk assessment.

### Service ports

- **Messaging.** Declare `channels` (`whatsapp`, `messenger`, `instagram`, `telegram`, `viber`). `send({ channel, to, text | template, idempotencyKey? })` answers like SMS. A WhatsApp app replaces the built-in Meta sender when the merchant chooses it.
- **Push.** `send({ audience, to, notification, idempotencyKey? })`: `to` lists Scalius staff or customer ids; map them to your own subscribers. Web Push is built in; your app replaces it for buyers when chosen.
- **Search.** `search({ query, locale, marketId, limit })` answers `{ productIds, correctedQuery? }`, best first. The platform reads, prices and filters the products itself and uses built-in search when you fail or take more than 1.5 s. Keep your index current from `product.*` events.
- **Address.** `suggest({ query, country, locale, sessionToken })` answers up to 8 suggestions; `resolve({ id, … })` answers the canonical address fields. Declare `countries`. The form still validates the address.
- **FX.** `rates({ base, quotes })` answers exact decimal rates (`"0.0084"`). The scheduled tick asks; buyers never wait on you; a failure keeps the last rate.
- **Identity.** `authorize({ state, nonce, codeChallenge, redirectUri, locale })` answers the provider's https sign-in URL; `exchange({ code, codeVerifier, nonce, redirectUri })` checks the ID token and answers `{ subject, email?, emailVerified, phone?, phoneVerified, name? }`. Set `emailVerified` only when the provider verified it: only verified facts link to an existing account.

## List columns

`admin.listColumns: [{ id, resource, title, type, filterable?, source }]` adds columns to the orders, products or customers list. `type` is `text`, `number`, `money` (store integer minor units; the list shows the amount), `date` or `boolean`. `source` is `{ kind: "object", object, field }` (the record whose id is the row's id) or `{ kind: "customField", key }` (your field on that resource). `filterable` needs a declared index that starts with the field. Merchants pick the columns; a list shows at most 5.

## Data updates

An app declares versioned updates of its own data (`manifest.migrations`, up to 200, versions increasing) and one handler for each (`migrations: { "1": async (ctx) => { … } }`). They use `ctx.objects` and `ctx.kv`, so they work the same on D1, TursoDB and PostgreSQL.

- The platform runs each pending update once, in order, before the app's next run after an install or an update. It records each one (`plugin_migrations`) and stores the newest version on the installation (`migratedVersion`). Checkout functions do not wait for them.
- A failed update stops the run. A dashboard update then puts back the previous version. A bundled app (updated by a deploy) becomes `failed` until it is fixed.
- A rollback does not reverse data. Make each update idempotent (it can run again after a crash), and keep the previous version able to read the result: add first, remove in a later version.
- Never renumber or remove a declared update.
- Uninstall with "keep data" keeps the record, so a reinstall does not run the updates again. "Delete data" removes it.
- "Keep data" keeps your settings too (secrets only for a release signed by the same developer key): a reinstall picks them up. Until then the dashboard lists your data as "From a removed app", and a Super Admin may delete it there.

## Install, update and trust

- **Workers Free (bundled).** An operator adds the app to the fork and deploys: `pnpm plugin add <path>`, or `pnpm plugin add <vendor.name> --registry <index URL>` for a signed registry release. The Apps page shows that command.
- **Workers Paid (sandbox).** The Apps page installs from a registry with one click, or from an uploaded package (a ZIP that `pnpm plugin pack` writes). The platform downloads the release, checks its SHA-256, its compatibility, its Ed25519 signature and its images, and stores it in R2. Nothing runs until a Super Admin approves its access.
- **Signatures.** A release is signed over its id, version, bundle SHA-256 and the SHA-256 of its canonical manifest (`@scalius/shared/plugins/registry`). The store trusts the official key (pinned in code; empty until the official registry exists) and the keys a Super Admin added (Apps → Registries and trusted developers). An upload signed by an unknown developer, or not signed, installs only after a Super Admin chooses "trust this developer" or "install unsigned app".
- **Updates.** The Apps page shows newer registry versions. An update that asks for more access waits for a Super Admin. An active app loads the new code and runs its data updates at once; when either fails, the previous version comes back and the page says why.
- **Private apps.** Keep an app in `plugins/` of your fork (both loaders: `pnpm plugin add plugins/<dir>`, then deploy), or sign it with your own key and upload it on Paid. Add your public key as a trusted developer once, and your uploads need no extra step. A private app never needs the official registry.

## Quotas

The plan profile (`planLimits().plugins`) sets each app's ceilings. The manifest's `limits` apply within them.

| Limit | Free | Paid |
| --- | --- | --- |
| CPU per run (sandbox) | 50 ms | 200 ms |
| Wall time per run | 10 s | 30 s |
| Platform calls per run | 50 | 1,000 |
| Stored data (records and key/value) | 50 MiB | 1 GiB |
| Event, route and cron runs per minute | 600 | 6,000 |

- A run over a limit fails, and the app's log records a breach. Five breaches within an hour (at most one counted each minute) stop the app; the staff get a notice. A Super Admin starts it again by approving it.
- Storage is measured once a day. Above the limit, writes that add data fail with `quota_storage`; deletes still work.
- Checkout functions, provider operations and storefront output are paced by the platform, so the runs-per-minute limit does not count them.
- The emergency switch on the Apps page (and the `dashboard.apps.stop` and `dashboard.apps.stop_third_party` operations) stops one app, or every app not published by Scalius, at once. It runs no app code.

## The stable plugin API

This package, the manifest (`packages/shared/src/plugins`), the event catalogue and the bridge contract are the plugin API. It is the one part of Scalius that keeps backward compatibility.

- `apiVersion` names the version an app was built for (`PLUGIN_API_VERSION`, date-versioned). `SUPPORTED_PLUGIN_API_VERSIONS` lists the versions this platform runs. Install, activation and update refuse a manifest built for a version that is not listed, or whose `minPlatformVersion` is newer than this release, with a plain reason.
- Within one `apiVersion`, changes are additive only: new optional manifest fields, new `ctx` methods, new events, new function points and provider operations. Existing fields, types, error codes and behaviour do not change.
- A breaking change makes a new `apiVersion`. The platform then supports the old and the new version side by side for at least 12 months. The changelog marks each deprecation with the version that removes it.
- A deprecated field or method keeps working until the platform drops its `apiVersion`.

## Contract checks

`packages/shared/src/plugins/abi.snapshot.test.ts` seals the manifest JSON Schema, emitted SDK declarations, protocol constants, events, function/provider/UI schemas and scopes. Stable HTTP operation schemas have their own compatibility gate in `apps/api/src/openapi/stable-operations.test.ts`. Update snapshots only after reviewing an additive change; a breaking change needs a version decision. Runtime validation tests still cover refinements JSON Schema cannot express.

## License

AGPL-3.0-only with the [Scalius Plugin Exception](PLUGIN-EXCEPTION): an app, theme or client that uses this package only through its exported entry points may be licensed and distributed on any terms, including bundled into a store. The SDK itself, and changes to it, stay under the AGPL.
