// Test-only apps (testing/apps/*): the platform's tests run them through the
// bundled loader, the sandbox loader and checkout. They never ship: no
// lockfile bundles them and the catalog does not list them (they are not in
// plugins/). A test adds them to the bundled registry with:
//
//   vi.mock("./bundled.gen", async (importOriginal) =>
//     (await import("./testing/fixture-apps")).withFixtureApps(await importOriginal()));
//
// - acme.hello: every surface (settings with secrets, objects, KV, events,
//   admin pages, cards, actions and widgets, public routes and the proxy,
//   cron, a signed webhook, a checkout function and head tags).
// - acme.wishlist: a proxy page, a product.updated handler and a dashboard
//   page.
// - acme.loyalty: checkout.discounts with a declared read and a commit.
// - acme.wholesale: B2B on declared reads (a hop, per-line records, custom
//   fields) at four points, and a commit of the hop's record.
// - acme.risk-guard: order risk as an order.created handler (ctx.orders).
// - acme.bulk-discount: checkout.discounts and cart.validate by quantity.
// - acme.order-tagger: an order card and actions through `ctx.api`.
// - acme.notes: checkout and customer-account blocks.
// - acme.marketplace: a multi-seller split kept from fulfilment and refund line facts.
// - acme.subscriptions: a purchase option, contracts from order.created, a
//   renewal cron (orders.create + payments.charge of the saved method) and a
//   test payment provider that vaults, charges off-session, captures and voids.
//
// Each fingerprint is a fixed test value: an installation made from an entry
// matches the "deployed" code, and a test that changes it sees an update.

import { manifest as bulkDiscountManifest } from "./apps/bulk-discount/src/index";
import { manifest as helloManifest } from "./apps/hello/src/index";
import { manifest as loyaltyManifest } from "./apps/loyalty/src/index";
import { manifest as notesManifest } from "./apps/notes/src/index";
import { manifest as orderTaggerManifest } from "./apps/order-tagger/src/index";
import { manifest as wishlistManifest } from "./apps/wishlist/src/index";
import { manifest as wholesaleManifest } from "./apps/wholesale/src/index";
import { manifest as riskGuardManifest } from "./apps/risk-guard/src/index";
import { manifest as marketplaceManifest } from "./apps/marketplace/src/index";
import { manifest as subscriptionsManifest } from "./apps/subscriptions/src/index";
import type { BundledPluginEntry } from "../loaders/bundled";

/** Directories of the fixture apps, for `packPlugin` (sandbox tests). */
export const FIXTURE_APP_SOURCES = {
  "acme.hello": "./apps/api/src/plugins/testing/apps/hello",
  "acme.wishlist": "./apps/api/src/plugins/testing/apps/wishlist",
  "acme.loyalty": "./apps/api/src/plugins/testing/apps/loyalty",
  "acme.bulk-discount": "./apps/api/src/plugins/testing/apps/bulk-discount",
  "acme.order-tagger": "./apps/api/src/plugins/testing/apps/order-tagger",
  "acme.notes": "./apps/api/src/plugins/testing/apps/notes",
  "acme.wholesale": "./apps/api/src/plugins/testing/apps/wholesale",
  "acme.risk-guard": "./apps/api/src/plugins/testing/apps/risk-guard",
  "acme.marketplace": "./apps/api/src/plugins/testing/apps/marketplace",
  "acme.subscriptions": "./apps/api/src/plugins/testing/apps/subscriptions",
} as const;

export const HELLO_BUNDLED: BundledPluginEntry = {
  version: helloManifest.version,
  sha256: "5a1e".repeat(16),
  load: () => import("./apps/hello/src/index"),
};

export const FIXTURE_APPS: Readonly<Record<string, BundledPluginEntry>> = {
  "acme.hello": HELLO_BUNDLED,
  "acme.wishlist": { version: wishlistManifest.version, sha256: "a15e".repeat(16), load: () => import("./apps/wishlist/src/index") },
  "acme.loyalty": { version: loyaltyManifest.version, sha256: "10a1".repeat(16), load: () => import("./apps/loyalty/src/index") },
  "acme.bulk-discount": { version: bulkDiscountManifest.version, sha256: "b01c".repeat(16), load: () => import("./apps/bulk-discount/src/index") },
  "acme.order-tagger": { version: orderTaggerManifest.version, sha256: "0da9".repeat(16), load: () => import("./apps/order-tagger/src/index") },
  "acme.notes": { version: notesManifest.version, sha256: "4073".repeat(16), load: () => import("./apps/notes/src/index") },
  "acme.wholesale": { version: wholesaleManifest.version, sha256: "b2b0".repeat(16), load: () => import("./apps/wholesale/src/index") },
  "acme.risk-guard": { version: riskGuardManifest.version, sha256: "715c".repeat(16), load: () => import("./apps/risk-guard/src/index") },
  "acme.marketplace": { version: marketplaceManifest.version, sha256: "5e11".repeat(16), load: () => import("./apps/marketplace/src/index") },
  "acme.subscriptions": { version: subscriptionsManifest.version, sha256: "50b5".repeat(16), load: () => import("./apps/subscriptions/src/index") },
};

/** The bundled registry with every fixture app added. */
export function withFixtureApps<T extends { BUNDLED_PLUGINS: Readonly<Record<string, BundledPluginEntry>> }>(module: T): T {
  return { ...module, BUNDLED_PLUGINS: { ...module.BUNDLED_PLUGINS, ...FIXTURE_APPS } };
}

/** The bundled registry with the reference app only (tests that count what is bundled). */
export function withHelloBundled<T extends { BUNDLED_PLUGINS: Readonly<Record<string, BundledPluginEntry>> }>(module: T): T {
  return { ...module, BUNDLED_PLUGINS: { ...module.BUNDLED_PLUGINS, "acme.hello": HELLO_BUNDLED } };
}
