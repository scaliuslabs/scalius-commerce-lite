# Scalius app platform reference

These pages describe what an app (a plugin) can do in a Scalius store and the rules the platform holds it to. They are written for developers who build apps, not for people who work on Scalius itself.

Start with the SDK's [quick start](../README.md). It shows how to scaffold an app, test it with the harness, validate it, preview it and pack it. Come back here when you need the full rules.

## The pages

| Page | What it covers |
| --- | --- |
| [Apps](apps.md) | The manifest, every extension point, access and consent, the app lifecycle (install, activate, update, pause, uninstall, reinstall), the two loaders, signing and trust, limits, isolation, storage, routes, admin UI, jobs, events and webhooks, and what happens when something fails. |
| [Commerce hooks](commerce-hooks.md) | How an app takes part in commerce: scopes and event payloads, provider ports, the checkout-function interface, the stable app API (`ctx.api.call`), deferred payment, line facts and refunds, the payment port's optional parts, purchase options, discount classes, writes that build a store, and what the contract seal promises. |
| [Stable app API reference](operations.md) | Generated from the sealed contract: every operation an app may call with `ctx.api.call`, its scopes, idempotency and revision rules, parameters, body, response, and every resource schema. |
| [Event reference](events.md) | Generated from the event catalogue: every topic, the resource it is about, its facts and the stable read for the rest. |
| [Storefront](storefront.md) | Drawing on the storefront: sections, components, skins, templates, page presets, slots, settings, bindings, islands, `Deferred`, core embeds, testing, the packer and the budgets. |
| [Build a theme](themes.md) | A theme that works on any store, not only yours: the mental model, the portability rules (store identity, links, merchant fields, empty stores, artwork rights, no-JavaScript controls, languages and logical CSS) with right and wrong examples, testing on three stores, and a release checklist. |
| [llms.txt](llms.txt) | A one-page index of these guides and the rules, for AI coding tools. |

## Reading order

1. The SDK [README](../README.md): build and test your first app.
2. [Apps](apps.md): the manifest and the lifecycle. Every app needs this.
3. [Commerce hooks](commerce-hooks.md) when your app reads or writes store data, runs at checkout or implements a provider.
4. [Build a theme](themes.md), then [Storefront](storefront.md), when your app draws on the storefront.

Building with an AI agent? Every scaffolded app has an `AGENTS.md` with the rules and the checks to run; point other tools at [llms.txt](llms.txt).

## Where the contract lives

The code is the truth. When a page and the code disagree, the code wins. The versioned contract is in these public packages:

- `@scalius/plugin-sdk`: `definePlugin`, `defineManifest`, the `ctx` types, `ProviderError`, `APP_ERROR_CODES`.
- `@scalius/plugin-sdk/manifest`: `parsePluginManifest`, the strict manifest parser, and the contract's tables and schemas: `EVENT_TOPICS` and each topic's facts and representation, webhook signing, function input and output schemas, custom field types, resource states, provider operations and `translationCoverage`.
- `@scalius/plugin-sdk/testing` and `@scalius/plugin-sdk/fixtures`: the test harness, the stable-API contract checker and typed fixtures.
- `@scalius/plugin-sdk/storefront`, `@scalius/plugin-sdk/storefront/testing`, `@scalius/plugin-sdk/island` and `@scalius/plugin-sdk/pixel`: storefront modules, their tests, client islands and pixels (buyer events, [storefront.md](storefront.md#buyer-events)).
- The generated [stable app API reference](operations.md) and [event reference](events.md).

Plugin API version: `2026-10` (`PLUGIN_API_VERSION`). Within one version the contract only grows. See [The contract seal](commerce-hooks.md#8-the-contract-seal).
