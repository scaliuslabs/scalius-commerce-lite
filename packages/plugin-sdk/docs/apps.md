# Apps

This page is the platform reference for Scalius apps. The SDK [README](../README.md) is the quick start. Checkout, the app API and providers are in [Commerce hooks](commerce-hooks.md). Drawing on the storefront is in [Storefront](storefront.md).

Plugin API version `2026-10`.

## What an app is

An app is an npm package that depends on `@scalius/plugin-sdk`. It has two parts:

- **The manifest.** It declares everything the app may do: its access, its data, its handlers and its surfaces. The store shows it to a Super Admin before anything runs.
- **The handlers.** The functions the platform calls: event handlers, checkout functions, routes, cron jobs, background jobs, providers, data updates and lifecycle hooks.

```ts
import { defineManifest, definePlugin, PLUGIN_API_VERSION } from "@scalius/plugin-sdk";

export const manifest = defineManifest({
  id: "acme.tally",
  name: "Order tally",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  description: "Counts paid orders.",
  author: { name: "Acme" },
  events: ["order.paid"],
});

export default definePlugin({ manifest, events: { "order.paid": async (event, ctx) => { /* … */ } } });
```

The platform has six primitives: **Objects**, **Custom fields**, **Functions**, **Providers**, **Components** and **Buyer UI**. A store that uses none of a primitive pays nothing for it: no reads, no writes, no extra work at checkout.

## Extension points

| Point | Declare | Implement |
| --- | --- | --- |
| Events | `events` | `events[topic](event, ctx)` |
| Checkout functions | `functions: [{ point, priority, onError, reads }]` | `functions[point](input, settings)` |
| Providers (14 ports) | `providers.<port>` | `define<Port>Provider({ … })` |
| Admin pages, cards, actions, widgets | `routes.admin`, `admin.*` | `routes.admin[name]` answering with `ui.*` |
| Admin list columns and filters | `admin.listColumns` | No code: object records or your custom fields |
| Order timeline lines | `admin.timeline` | `ctx.timeline.add(…)` |
| Order risk and holds | `events: ["order.created"]`, `write_orders` | `ctx.orders.assessRisk(…)`, `ctx.orders.hold(…)` |
| Objects and custom fields | `objects`, `customFields` | `ctx.objects`, `ctx.customFields` |
| Buyer UI | `storefront.extensions`, `checkout.attributes` | `extensions[target]`, a pure render returning `{ ui }` |
| Purchase options | `checkout.purchaseOptions` | Your functions price them |
| Storefront sections, components, skins, templates, page presets | `storefront.sections`, `components`, `skins`, `templates`, `pagePresets` | `defineStorefront` in `src/storefront.tsx` |
| Islands, stylesheet, public files | `storefront.islands`, `stylesheet`, `connect` | `src/islands/<name>.ts`, `src/storefront.css`, `public/` |
| Scripts, head tags, storefront proxy | `storefront.scripts`, `head`, `proxy` | |
| Public routes, inbound webhooks | `routes.public`, `routes.webhooks` | `routes.public[name]`, `routes.webhooks[name]` |
| Customer roles | `read_customers` | `ctx.customers.roles.*` |
| Background jobs | `jobs` | `jobs[name](ctx, job)`, started with `ctx.jobs.start(…)` |
| Cron | `cron` | `cron[name](ctx, { name, scheduledAt })` |
| Data updates | `migrations` | `migrations[version](ctx)` |
| Lifecycle | nothing | `lifecycle.install`, `activate`, `deactivate`, `uninstall`, `enable`, `disable` |
| Sales channels | `salesChannels` | Read your channel's products with `ctx.api` |

The platform refuses a handler the manifest does not declare, and a declared item without a handler. It checks this when you pack the app and again when the store loads it.

**Which seam to use.** A decision inside a request is a function. A provider of a capability is a port. A reaction after a write commits is an event handler.

## Names

Every name in the manifest follows one rule, and a refusal names the rule (`Use snake_case: …`).

| Kind | Rule | Used for |
| --- | --- | --- |
| Key | snake_case, `^[a-z][a-z0-9_]{0,47}$` | Settings, timeline kinds, checkout attributes, purchase options, cron jobs, background jobs, cards, actions, widgets, tabs, list columns, settings groups, storefront section, component, skin, template and page preset ids |
| URL name | snake_case or kebab-case, up to 48 characters | Route names, page ids, island names, feature ids, provider ids, sales channel ids |
| Field key | snake_case, up to 64 characters | Object field keys |
| Object type | snake_case, 2 to 48 characters; full name `<app id>.<type>` | Object types |
| Custom field key | snake_case words joined by single `_`, 2 to 64 characters | `customFields[].key` |

- An app id is `vendor.name` in lower case. Ids under `scalius.*` are reserved for apps bundled with Scalius; an upload or registry install of one is refused.
- A provider's store id is `<app id>:<provider id>`.
- A checkout attribute and a purchase option are named `<app id>.<key>` outside the manifest.

## The manifest

`parsePluginManifest` (`@scalius/plugin-sdk/manifest`) validates a manifest. Unknown keys fail. `defineManifest` keeps the literal types, so `definePlugin` types each handler's `ctx` by your manifest (`ctx.objects.<type>` records, `ctx.settings.<key>`).

| Field | Limit | Notes |
| --- | --- | --- |
| `id`, `name`, `version`, `apiVersion`, `description`, `author` | | Identity. `version` is semver. `apiVersion` is `PLUGIN_API_VERSION`. |
| `scopes` | | Access scopes (see [Access](#access-and-consent)). |
| `allowedHosts` | 20 | Hosts `ctx.http` may reach: exact, or `*.example.com`. `host:port` names one non-default port. No IP literals, no localhost. Empty means no network. |
| `events` | 40 | Topics, `<resource>.*` or `*`. |
| `functions` | one per point | `{ point, priority (0 to 1000, default 100), onError, reads }`. |
| `checkout.attributes` | 10 | Typed buyer inputs (`text`, `multiline`, `number`, `boolean`, `date`, `choice`). All of an order's attributes together are at most 8 KiB. |
| `checkout.purchaseOptions` | 10 | `{ key, title, description? }`. Needs a checkout function or a payment provider. |
| `providers` | 24 in all | Grouped by port. |
| `routes.admin`, `routes.public`, `routes.webhooks` | 40, 20, 10 | `{ name, methods?, description? }`. |
| `cron` | 10 | `{ name, schedule }`. |
| `jobs` | 10 | `{ name, title }`. Declaring a job asks for no access. |
| `objects` | 20 types | Typed records in your namespace. |
| `customFields` | 50 | Your fields on core resources. |
| `messaging.recipients` | 4 | `{ object, field }`: fields of your objects that may be emailed or texted. |
| `migrations` | 200 | `{ version, description }`, versions increasing. |
| `salesChannels` | 3 | `{ id, name }`. Each becomes the channel `<app id>:<id>`. |
| `features` | 24 | Parts the merchant turns on one at a time. |
| `settings` | 80 | The merchant's form for the app. |
| `admin.pages`, `cards`, `actions`, `widgets` | 10, 20, 20, 5 | Each names an admin route. |
| `admin.listColumns` | 10 | Merchants pick columns; a list shows at most 5. |
| `admin.settingsGroups`, `admin.timeline` | 20, 20 | |
| `storefront.*` | see [Storefront](storefront.md) | Sections, components, skins, extensions, scripts and more. |
| `limits` | | `cpuMs` 5 to 200 (default 50), `wallMs` 100 to 30,000 (default 10,000). |
| `translations` | 20 languages | Dashboard text by BCP 47 tag. |

**Listing fields** describe the app on the Apps page. They grant nothing, and changing them needs no new approval: `icon` (square SVG or PNG, at most 64 KiB), `tagline` (100 characters), `categories` (3), `screenshots` (6 PNG, JPEG or WebP files, at most 512 KiB each), `support` (`{ url?, email? }`), `privacyPolicyUrl`, `documentationUrl`, `changelogUrl` (https), `countries` (ISO 3166-1 alpha-2, upper case) and `minPlatformVersion`. The packer checks every image file by its bytes and refuses an SVG with scripts, links, external references or entities.

**Settings types:** `text`, `textarea`, `number`, `boolean`, `select`, `multiselect`, `secret`, `url` (https), `email`, `color`. A `secret` is encrypted at rest and masked everywhere. Only `ctx.settings` sees it decrypted. A secret that cannot be opened reads as `null`.

## Access and consent

Your manifest asks; a Super Admin approves. Every `ctx.api` call, timeline write and customer message is checked against the approved access.

### Scopes

| Tier | Scopes | Effect |
| --- | --- | --- |
| Access | `read_products`, `write_products`, `read_inventory`, `write_inventory`, `read_orders`, `write_orders`, `write_payments`, `write_payment_methods`, `write_refunds`, `write_fulfillments`, `read_customers`, `write_customers`, `write_marketing`, `read_discounts`, `write_discounts`, `read_content`, `write_content`, `read_objects`, `write_objects`, `read_files`, `write_files`, `read_gift_cards`, `write_gift_cards`, `write_webhooks`, `read_settings`, `write_themes`, `write_navigation`, `write_places` | Each grants a fixed set of store permissions. A `write_*` scope includes its `read_*` scope. |
| Contact data | `read_customer_names`, `read_customer_emails`, `read_customer_phones`, `read_customer_addresses` | Grant no permission alone. Each reveals one kind of buyer contact data in what your other scopes return. |
| Capability | `send_messages_any` | Grants no permission. Lets `ctx.messaging` reach any address. |

The consent screen marks these as **Sensitive**: every contact data scope, `send_messages_any`, `write_payments`, `write_payment_methods`, `write_refunds`, `write_gift_cards`, `write_webhooks`, `write_themes` and `write_navigation`.

Rules worth knowing:

- Stock belongs to `read_inventory` and `write_inventory`, never to `write_products`.
- `write_marketing` sends to customers who agreed to marketing. The platform resolves the address and never returns it.
- `write_payments` records money received against an invoice. `write_payment_methods` charges, captures and voids, and lists and removes saved methods, only for your own purchase options. `write_refunds` gives money back.
- `write_themes` changes the shared theme draft, never the live theme. `write_navigation` writes menus. Staff publish the theme and choose where a menu shows.
- No scope reaches staff, agent access, the store's own webhook endpoints or app management.
- An admin route may name one of the app's scopes as its `scope`. Staff then also need that scope's dashboard permission to use the route.

### Contact data

Buyer contact data is protected field by field. `address` means the street: address lines, company and neighbourhood. The region (country, admin area, city, delivery places, postal code) is never protected, because shipping, tax and functions need it.

- Without a contact scope, the matching fields of an operation's output read `null`. They are marked `x-scalius-protected` in the contract.
- Filtering or searching by a contact field without its scope is refused with 403 `contact_scope_required`.
- A provider port declares the contact data it carries. A courier needs names, phones and addresses. SMS, courier history and messaging need phones. Email needs emails. Address needs addresses. A payment provider receives in `buyer` only the fields its scopes reveal. A manifest that declares a provider without its required scopes is refused.
- Checkout function inputs and event facts never carry contact data.

### Consent and approvals

- Activation shows a Super Admin everything the manifest asks for: scopes, hosts, provider ports, message recipients, objects, storefront code, browser hosts and Buyer UI slots.
- An update that asks for more access waits for a Super Admin. An update that asks for the same or less needs no approval.
- Each feature asks for its own access when it is turned on (see [Features](#features)).

## Features

An app with several services declares each as a feature (up to 24). A feature claims, by name, items the manifest declares elsewhere (providers, settings groups, routes, cron jobs, events, functions, admin surfaces, storefront surfaces) and may add its own `scopes` and `allowedHosts`.

- Every feature starts off. What no feature claims is the app's base and runs whenever the app runs.
- Turning a feature on asks a Super Admin to approve that feature's access only. Turning it off revokes it at once.
- An off feature registers nothing and costs nothing. Its settings are hidden and absent from `ctx.settings`, but kept for later.
- `ctx.features` lists the features that are on. `lifecycle.enable(ctx, { feature })` runs after a feature is turned on; `lifecycle.disable(ctx, { feature })` runs before it is turned off.
- An item belongs to at most one feature and may point only at items of its own feature or of the base.
- An update keeps the features that are on and starts new ones off.

## Lifecycle

An installed app has one of four states:

| State | Meaning |
| --- | --- |
| `installed` | Installed, not running. New installs and updates waiting for approval sit here. |
| `active` | Running. |
| `disabled` | Turned off by staff, stopped by its limits, or stopped by the emergency switch. |
| `failed` | The store could not load the code or apply an update. The app's page says why. |

### Install

- **Bundled (every plan).** An operator adds the app to the store's code and deploys. The Apps page then lists it as installed, not active.
- **Upload or registry (Workers Paid with the sandbox on).** A Super Admin installs a release from a registry or uploads the ZIP that `pnpm plugin pack` writes. The store checks the release's SHA-256, its compatibility, its signature and its images, then stores it privately.

Nothing of the app runs after an install. Install refuses a manifest built for an `apiVersion` the store does not support, or a `minPlatformVersion` newer than the store, with a plain reason.

### Activate

A Super Admin reviews the access and activates the app. Required settings must be filled first. The platform then runs pending data updates, then `lifecycle.activate`. Only events after the first activation reach the app.

### Update

- An active app loads the new code and runs its data updates at once. If either fails, the previous version comes back and the app's page says why.
- An update that asks for more access returns the app to `installed` until a Super Admin approves it. Its events wait meanwhile.
- A bundled app follows the deployed code. If the deployed release cannot be installed, the app becomes `failed` with the reason.
- An update of an installed app must come from the same signing key. An app installed unsigned takes the key of its first signed update. A bundled release is not checked this way.

### Pause and stop

- **Deactivate** (staff) sets `disabled`. `lifecycle.deactivate` runs.
- **Limit breaches.** Five breaches within an hour (at most one counted each minute) stop the app, and staff get a notice. A Super Admin starts it again by approving it.
- **Emergency switch.** The Apps page stops one app, or every app not published by Scalius, at once. It runs no app code.
- While an app is not running, its events wait (see [Events](#events)) and its running jobs fail with `app_inactive`.

### Uninstall

`lifecycle.uninstall(ctx, { keepData })` runs, then the store removes the app. The merchant chooses:

- **Uninstall, keep data.** The app's records, key/value data, custom fields, customer roles, data-update record and settings stay. Waiting event deliveries are cancelled. The dashboard lists the data under Apps, "Data from removed apps", where a Super Admin may delete it later.
- **Uninstall, delete data.** Everything the app owns is deleted: object types and records, custom fields and values, `ctx.kv`, customer roles, jobs, its own webhook endpoints, logs, deliveries and cron runs. Catalogue items the app created and that are in the trash are permanently deleted, unless inventory history, an order or a shown file still needs them. Live catalogue items it created become the store's own.

Uninstalling always deletes the app's own webhook endpoints and drops its waiting events.

### Reinstall and kept data

Kept data belongs to the key that signed the release that wrote it. A bundled or unsigned release has no key.

- A release under the same app id from the **same key** (or, for a bundled or unsigned release, again with no key) reclaims everything, settings included. Data updates already recorded do not run again.
- A release from **another key**, or a move between a signed upload and a bundled or unsigned release, never reclaims the data silently. The install is held. Apps, "Data from removed apps" lists the kept data with the waiting release and two choices:
  - **Delete data.** The data is deleted and the release installs clean.
  - **Hand over data.** A Super Admin confirms that the new release's code may read and change that data. The release then installs and reclaims it.

A held upload offers the same choice in the upload dialog ("Hand over data and install"); a held bundled release shows as waiting in the list and installs as soon as the data is handed over. If the old release kept nothing the new one could read (default settings, no records or values), nothing is held: the new release installs clean.

To move an app to another developer, or from an upload into your store's own bundled code, uninstall it keeping its data, then install the new release and hand the data over.

## Two loaders

One module and one handler contract run in both loaders. Harness tests prove the contract, not equal isolation, deployment behaviour or performance.

| | Bundled | Uploaded or registry |
| --- | --- | --- |
| Plan | Every plan, including Workers Free | Workers Paid with the sandbox on |
| Install | Added to the store's code, then deployed | Verified, stored privately, activated from the dashboard; no deploy |
| Execution | In process, as trusted deployment code | A Dynamic Worker isolate per app version |
| Network | Through `ctx.http`; a best-effort guard refuses a plain `fetch` | No outbound network at all; only the platform bridge |
| Bindings | None passed to app code | None |
| CPU limit | Not enforced (a timeout cannot stop synchronous code) | `limits.cpuMs` within the plan's ceiling |

A store without the sandbox cannot run uploaded apps: their calls fail as `unavailable` (provider calls as `misconfigured`).

Third-party apps call only `stable` app API operations. A bundled first-party app may also call `beta` ones. No app calls `internal` ones.

## Signing and trust

- A release is signed with an Ed25519 key over its app id, version, bundle SHA-256 and the SHA-256 of its canonical manifest (`@scalius/shared/plugins/registry`). The storefront files are sealed into the bundle, so the signature covers them too.
- `pnpm plugin keygen <dir>` makes a key. `pnpm plugin pack <app> --key <dir>` writes `signature.json` and the upload ZIP. Keep the key out of every repository.
- A store trusts the official key (pinned in code; empty until the official registry exists) and the keys a Super Admin added under Apps, "Registries and trusted developers".
- An upload signed by an unknown key, or not signed, installs only after a Super Admin chooses to trust the key or to install the unsigned app.
- The trust prompt and the app's page show the signing key's **fingerprint**. The developer name beside it is the signer's own label: Scalius does not verify it. A trusted key shows as "Trusted by you", never as a verified developer. Trusting a key is the merchant's decision.
- A registry is a static, signed index any HTTPS host can serve (`pnpm plugin index`). A private app never needs the official registry: sign it with your own key, add the public key as a trusted developer once, and upload.

## Isolation guarantees

What the platform guarantees:

- An app reaches store data only through `ctx`, checked against its approved grant, its scopes' permissions and the operation's tier.
- An uploaded app has no bindings and no network. Its only outside access is `ctx.http` to its approved hosts.
- Values crossing the bridge are structured-cloned.
- Functions and storefront components get their data as input. They do no I/O.
- Each app sees only its own objects, custom fields, `ctx.kv`, customer roles, jobs, webhook endpoints and checkout attributes.
- App JavaScript never runs on cart, checkout, the receipt, account, payment recovery or order tracking pages. Buyer UI there is data that core renders.
- Credentials never reach listings, browser output, event payloads or logs. Logs mask secrets, emails and phone numbers.

What it does not guarantee:

- Bundled code is trusted deployment code, not a sandbox. The `fetch` guard does not cover `WebSocket`, `caches` or sockets. Bundle only code you trust.
- A wall-time limit cannot interrupt synchronous code that blocks a bundled app's event loop.
- Approved browser islands are trusted same-origin JavaScript on public pages.

## Limits

The plan sets each app's ceilings. Your manifest's `limits` apply inside them.

| Limit | Free | Paid |
| --- | --- | --- |
| CPU per run (sandbox) | 50 ms | 200 ms |
| Wall time per run | 10 s | 30 s |
| Platform calls per run | 50 | 1,000 |
| Stored data (records and key/value) | 50 MiB | 1 GiB |
| Event, route and cron runs per minute | 600 | 6,000 |
| Messages per minute | 60 | 300 |
| Running background jobs | 3 | 10 |
| Job steps per drain | 3 | 12 |
| Held events while not running | 7 days, 2,000 | 30 days, 50,000 |

- A run over a limit fails and the app's log records a breach.
- Storage is measured once a day. Above the limit, writes that add data fail with `quota_storage`; deletes still work.
- Checkout functions, provider operations and storefront output are paced by the platform and do not count against runs per minute.
- `ctx.api.call` allows 60 calls a minute. `ctx.http.fetch` allows 60 requests a minute; a provider operation's calls to its own provider do not count.

## Storage

### Objects

`ctx.objects.<type>` holds typed records of your declared object types (`<app id>.<type>`). Methods: `get`, `getVersion`, `getByHandle`, `put`, `update`, `increment`, `delete`, `query`, `count`. The type name `batch` is reserved.

- A type declares up to 40 fields, up to 4 `indexes` and up to 2 `unique` sets. A record is at most 64 KiB; its id is 1 to 128 printable characters.
- An index entry is one field or a list of 1 to 4 fields. `json` and `list.*` fields cannot be indexed. A query uses equality on the leading fields of one index and orders by its next field. A `unique` set also answers an exact lookup on all its fields. `limit` is at most 100 (default 50).
- Every write advances the record's revision. A conditional write passes `expectedRevision` (`null` means "must not exist"). A conflict throws `object_conflict` and changes nothing.
- `update` merges top-level fields and, without a pinned revision, retries the merge so no update is lost. `increment` adds to a whole-number field within optional `min`/`max` bounds (`object_out_of_range`).
- `ctx.objects.batch([...])` writes up to 25 `put`, `delete` and `check` operations across types, all or nothing.
- A type's `admin` setting (`none`, `read`, `edit`) controls the dashboard's Content, Objects screens. A storefront-visible type exposes only published records.
- Field types: the custom field types below, plus `customer_reference` and `order_reference` (weak references, no cascade).

### Custom fields

Typed fields on core resources, owned by your namespace: `product`, `variant`, `customer`, `order`, `category`, `collection`, `brand`, `page`. `ctx.customFields.get(ownerType, ownerId)` and `set(...)` read and write only your own fields. The merchant's `custom` namespace is reached through `custom_fields.*` operations, which never show you another app's fields.

Types: `single_line_text`, `multi_line_text`, `integer`, `decimal`, `boolean`, `date`, `date_time`, `url`, `color`, `json`, `money`, `product_reference`, `variant_reference`, `collection_reference`, `media_reference`, `object_reference`. Every type except `boolean` and `json` also has a `list.` form. `object_reference` needs `to`, a qualified object type.

### Money

Money crosses every app boundary as integer minor units with an ISO 4217 code. A `money` field holds `{ amountMinor, currency }` in the store currency (`ctx.store.currency`). `{ amountMinor: 125000, currency: "BDT" }` is 1,250 taka. A write refuses a decimal, a bare number, another currency, a negative or fractional amount, or an amount off the store's price increment (`object_invalid`). A field's `min` and `max` are minor units.

### Key/value cache

`ctx.kv` is a private cache with TTLs, never a content API. Values are at most 64 KiB, keys 256 characters, TTLs at most one year, `list(prefix)` at most 1,000 keys. `getVersion` and `compareAndSet(key, expectedRevision | null, value)` give a compare-and-set (`kv_conflict`).

### Data updates

Declare versioned updates of your own data in `manifest.migrations` and one handler each (`migrations: { "1": async (ctx) => { … } }`).

- Each pending update runs once, in order, before the app's next run after an install or update. Checkout functions do not wait for them.
- A failed update stops the run. A dashboard update then restores the previous version; a bundled app becomes `failed` until fixed.
- A rollback does not reverse data. Make each update safe to run again, and keep the previous version able to read the result: add first, remove in a later version.
- Never renumber or remove a declared update.

## Routes

| Surface | URL | Who may call | Default methods | Body limit |
| --- | --- | --- | --- | --- |
| `routes.admin` | `/api/v1/plugins/<id>/admin/<name>` | Signed-in staff: app access to read, app use to change | `["GET"]` | 1 MiB |
| `routes.public` | `/api/v1/plugins/<id>/public/<name>` | Anyone; 60 requests a minute per client and app | `["GET"]` | 256 KiB |
| `routes.webhooks` | `/api/v1/plugins/<id>/webhooks/<name>` | Anyone; 60 requests a minute per client and route | `["POST"]` | 1 MiB |

- `methods` lists each of `GET POST PUT PATCH DELETE` at most once. Admin and public route names are unique together.
- A handler is `(request, ctx) => { status?, headers?, body? }`. Only active apps answer, and only declared routes and methods.
- Cookies never reach a handler. Admin and public handlers see only `accept`, `accept-language`, `content-type`, `if-none-match`, `user-agent` and `x-requested-with`. Webhook handlers see every header except credentials and network headers; `rawBody` holds the exact body for signature checks.
- Responses are JSON. An app cannot set cookies, CSP, CORS, `content-type` or redirect headers. A public or webhook response is `no-store` unless it sets exactly `cache-control: public, max-age=N` with N at most 300.

**Storefront proxy.** With `storefront.proxy`, `/apps/<id>/*` on the store's origin reaches your public routes. `request.customer` holds the signed-in customer's id and the roles your app gave them, never a session cookie. For a page navigation, answer `{ page: { title, description?, component, props, index? } }` (the store draws your `page` component from `props`, at most 64 KiB) or `{ redirect: "/a/store/path" }`. Proxy pages are `noindex` unless `index: true`.

## Admin UI

Admin pages, cards, actions and widgets are drawn by the dashboard from a declarative UI tree your admin route answers. No app HTML or JavaScript runs in the dashboard.

- **Pages** (10) appear under a navigation group (`apps`, `orders`, `products`, `customers`, `marketing`, `content`, `analytics`, `settings`), optionally with 2 to 8 tabs, each its own route.
- **Cards** (20) and **actions** (20) appear on a resource's detail page: `product`, `variant`, `order`, `customer`, `category`, `collection`, `brand`, `page` or `return`. An action may be `bulk` (up to 250 ids) or `destructive`.
- **Widgets** (5) appear on the dashboard home.
- **List columns** add a column (and optional filter) to the orders, products or customers list from an object record or your custom field.
- Answer pages, cards and widgets with `ui.page(...)` or `ui.view(...)`, and buttons and forms with `ui.result(...)`. The builder covers layout (`stack`, `columns`, `section`, `card`, `divider`), text (`heading`, `text`, `badge`, `banner`), data (`keyValue`, `stat`, `table`, `progress`, `empty`, `image`, `link`), and forms (`form`, `textField`, `textarea`, `numberField`, `select`, `checkbox`, `dateField`, `button`). `adminContext(request)` reads the request, including the dashboard language.

## Messaging

`ctx.messaging` sends `email`, `sms` and `pushCustomer`, and `notifyStaff`. It is refused inside a provider operation.

| Recipient | Needs |
| --- | --- |
| A customer by `customerId` | `read_customers`. The platform resolves the address and never returns it. |
| A staff member's email in `to` | Nothing extra |
| An address held in a declared `messaging.recipients` field, in `to` | The declaration; the consent screen lists it |
| Any other `to` | `send_messages_any`; otherwise `messaging_recipient_not_allowed` |
| A subscribed customer with `marketing: true` | `write_marketing`; email carries the unsubscribe footer |

A recipient field is a `single_line_text` field of your own object that leads an index or is unique alone, holding the address exactly as sent. Limits: subject 200 characters, HTML 100 KiB, text 50 KiB, SMS 1,000 characters.

## Order timeline and risk

- `ctx.timeline.add({ orderId, kind, message, fields?, idempotencyKey? })` is the one way an app writes on an order timeline. It needs `write_orders` and a kind declared in `admin.timeline`. `message` is plain text, 500 characters; `fields` at most 10.
- Order risk is an event, not a function. Handle `order.created` and call `ctx.orders.riskHistory(orderId)` (`read_orders`), `ctx.orders.assessRisk({ orderId, level, reasons })` and `ctx.orders.hold({ orderId, reason })` (`write_orders`). Each acts once per order and app, so a redelivered event changes nothing. A hold stops shipping, hand-over and status moves until staff release it. Nothing is cancelled automatically.

## Customer roles

`ctx.customers.roles` (`read_customers`) keeps your app's own roles on a customer: `grant(customerId, role, { ref? })`, `revoke(customerId, role)` and `list(customerId)`.

- A role is a lower-case letter, then up to 31 letters, digits, `_` or `-`. `ref` is your own id, 1 to 128 printable characters.
- At most 10 roles per app and customer (`customer_roles_limit`). A missing or deleted customer is refused (`customers_not_found`).
- Proxied requests carry them as `request.customer.roles` and checkout functions as `cart.customer.roles`, each app only its own.
- Uninstalling without keeping data deletes them.

## Background jobs

An admin action one run cannot finish is a job. Declare it (`jobs: [{ name, title }]`), start it with `ctx.jobs.start(name, { input, key })` and answer at once.

- The platform runs `jobs[name](ctx, job)` one step at a time: right after the response, then every minute. Each step is a run with the normal run limits.
- A step gets `{ id, name, input, state, step }` and answers `{ state?, progress?: { done, total }, message?, done? }`. `state` is at most 64 KiB, `input` 16 KiB, `message` 200 characters (never buyer contact data).
- A step commits with a compare-and-set on the step counter, so a crash repeats at most that step. Derive idempotency keys from `job.id` and `job.step`.
- A failing step is tried three times, then the job fails with `job_step_failed` or `job_invalid_step`.
- A second start with the same `key` answers the first job (`jobs_key_reused` for another input). Too many running jobs is `jobs_limit`.
- `get`, `list` and `cancel` see only your own jobs. Show progress with `ui.progress(...)`; while a live progress is on screen the dashboard re-reads the page every 3 seconds, for at most 10 minutes.

## Cron

A schedule has five fields and runs in the store's time zone. The platform checks schedules every 15 minutes on Workers Paid and about every 23 minutes on Free. A slot runs once and never overlaps the job's previous run. After downtime only the latest missed slot runs, within 24 hours. Use `scheduledAt`, not the clock, for time windows.

## Events

SQL triggers write event facts in the same transaction as the change, so a committed change is never lost. A store writes no event rows for topics nobody subscribes to.

- An event is `{ id, topic, apiVersion, occurredAt, resource: { type, id }, facts }`. Facts carry ids, states and quantities, never contact data, credentials or money. Read the resource with `ctx.api`.
- The catalogue (`EVENT_TOPICS` in `@scalius/shared/events`) is versioned and grows only by addition. It covers orders, returns, products and publications, variant inventory, purchase orders, transfers, customers and consent, fulfillments, refunds, shipments, payments, abandoned checkouts, discounts and redemptions, reviews, gift cards and their transactions, and object events. `customer.redact_requested` and `customer.data_requested` are reserved and have no emitter yet.
- Fulfilment and refund events list the order lines they cover (see [Line facts and refunds](commerce-hooks.md#5-line-facts-and-refunds)).

**Delivery to app handlers.**

- At least once. `event.id` is stable across attempts: use it as your idempotency key.
- A handler that throws or times out is retried after 1 min, 5 min, 30 min, 1 h, 3 h, 6 h and 12 h. After 8 attempts the delivery is exhausted; the merchant can retry it from the app's page.
- An app gets only events after its first activation, including those its own writes cause. Write only when something changes, so the handler converges.
- While the app is not running (off, stopped, failed, waiting for approval), its events wait and are delivered oldest first when it runs again, up to the plan's bound (7 days and 2,000 events on Free, 30 days and 50,000 on Paid). Past it the oldest are dropped. To catch up after a longer gap, read with `updatedSince`.

### Your own webhook endpoints

With the Sensitive `write_webhooks` scope, an app keeps up to 5 webhook endpoints of its own (`webhook_subscriptions.*`). Each stays on the app's approved hosts, topics and customer data. The signing secret is returned once.

- Deliveries are the store's own: the body is `{ id, topic, apiVersion, occurredAt, resource: { type, id }, facts, data }`, where `data` is the resource's sealed representation, projected through the endpoint's customer data.
- Headers: `Scalius-Event-Id` (your idempotency key), `Scalius-Topic`, `Scalius-Api-Version` and `Scalius-Signature: t=<unix seconds>,v1=<hex>`, where the hex is HMAC-SHA256 keyed by the whole secret (`whsec_…`) over `<t>.<raw body>`. Reject signatures older than 5 minutes. `signWebhookPayload` in `@scalius/shared/events` computes it.
- 10 s timeout, https only, no redirects followed. 8 attempts over about 23 hours. An endpoint with 8 or more failures over a day is disabled and staff are told.
- A body above 512 KiB carries `data: { truncated: true, id, fetch: { operationId, method: "GET", path } }`. `data: null` only means the resource no longer exists.
- Every delivery re-checks the app's live grant: a narrowed grant or an inactive app sends nothing. Uninstalling deletes the endpoints.

## Failure behaviour

| What fails | What happens |
| --- | --- |
| Event handler throws or times out | Retried on the schedule above; then exhausted and retryable by the merchant |
| App not running | Events wait (bounded); routes do not answer; jobs fail with `app_inactive` |
| Checkout function throws, times out, answers invalidly or exceeds its reads | Left out (`onError: "skip"`), or checkout stops with the store's buyer-safe text (`onError: "block"`, four points only) |
| Buyer UI extension fails | Omitted; it never blocks checkout |
| Storefront component or skin fails or is late | Core draws its own unit (or nothing for a section); the page is not cached |
| Provider operation fails | Follows the `ProviderError` category: `declined`, `retryable` (with `uncertain`), `misconfigured`. Anything else counts as retryable and uncertain. |
| Provider settings incomplete or unreadable | That provider is not ready; its siblings keep working |
| Data update fails | The previous version is restored (bundled: `failed`) |
| Limits exceeded | The run fails; five breaches in an hour stop the app |
| Storage over quota | Adding writes fail with `quota_storage`; deletes work |
| Theme draws with an inactive app's parts | Publishing is refused with `theme_apps_unavailable` |

A refusal of a `ctx.*` call throws an error with a stable `code` from `APP_ERROR_CODES` (`object_conflict`, `http_not_allowed`, `rate_limited`). A refused `ctx.api.call` answers `{ ok: false, status, data: null, error: { code, message } }`.

## Versioning

- `apiVersion` names the plugin API version an app was built for. `SUPPORTED_PLUGIN_API_VERSIONS` lists the versions a store runs.
- Within one version, changes are additive only: new optional manifest fields, new `ctx` methods, new events, new function points and provider operations. Existing fields, types, error codes and behaviour do not change.
- A breaking change makes a new `apiVersion`. The platform then runs the old and the new side by side for at least 12 months, and the changelog marks each deprecation with the version that removes it.

See [The contract seal](commerce-hooks.md#8-the-contract-seal) for exactly what is sealed.
