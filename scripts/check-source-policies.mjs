#!/usr/bin/env node
// The few structural rules that behaviour tests cannot express: import
// boundaries, forbidden sinks, and Worker request isolation. Everything else
// belongs in a behaviour test. Each policy carries the production rule it
// protects and a `sample` that must violate it, so a regex that silently stops
// matching fails `check-source-policies.test.mjs`.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { collectCoreBoundaryViolations } from "./core-boundaries.mjs";

const root = resolve(import.meta.dirname, "..");
const ts = createRequire(import.meta.url)("typescript");
const codeExtensions = new Set([".ts", ".tsx", ".astro", ".mjs", ".js"]);

/** Files under `path` (a file or directory), skipping tests, declarations, build output and generated code. */
export function codeFiles(path, extensions = codeExtensions) {
  const absolute = resolve(root, path);
  if (extensions.has(extname(absolute))) return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "generated" || entry.name === "testing") return [];
    const child = resolve(absolute, entry.name);
    if (entry.isDirectory()) return codeFiles(child, extensions);
    // `.gen.js` is an app's compiled storefront module (scripts/plugin-build.mjs): the app's code, not the repository's.
    if (!extensions.has(extname(entry.name)) || /\.test\.|\.d\.ts$|\.gen\.js$/.test(entry.name)) return [];
    return [child];
  });
}

const storefront = "apps/storefront/src";

/**
 * paths: files or directories. forbid: no file may match any pattern.
 * require: every file must match every pattern. extensions: optional file filter.
 * optionalPaths: skip listed paths that do not exist yet (a later slice adds them).
 * allow: repo-relative files the policy does not cover, each with its reason.
 * sample: text that must violate the policy.
 */
/**
 * A `$.` literal (quoted or a template) that is not `$.member(.member)*`
 * directly followed by its closing quote, a member being a plain name or a
 * template slot: '$.a[0]', '$.a-b', '$."a b"', '$.a..b', '$.a.', '$..a', and
 * a path glued to an index ('$.a' || '[0]'). A bare '$.' (a prefix joined to
 * a name) passes, and so does prose ("$.50 off": it has a space and no
 * quote or bracket inside). Duck-typed like a RegExp for `policyViolations`.
 */
const JSON_MEMBER_PATH_LITERAL = {
  test(text) {
    const member = String.raw`(?:[A-Za-z0-9_]+|\$\{[^}\n]*\})`;
    const wellFormed = new RegExp(String.raw`^\$\.(?:${member}(?:\.${member})*)?$`);
    const literal = /(['"`])(\$\.(?:(?!\1)[^\n\\])*)\1/g;
    for (const match of text.matchAll(literal)) {
      const body = match[2];
      if (wellFormed.test(body)) {
        // A path glued to an index: '$.a' || '[0]'.
        if (/^\s*\|\|\s*(['"`])\[/.test(text.slice(match.index + match[0].length))) return true;
        continue;
      }
      const words = body.replace(/\$\{[^}\n]*\}/g, "x");
      if (/\s/.test(words) && !/["'\[\]]/.test(words)) continue;
      return true;
    }
    return false;
  },
  toString() {
    return "a JSON path literal that is not $.member(.member)* (JSON_MEMBER_PATH_LITERAL)";
  },
};

export const policies = [
  {
    rule: "numbers, money, dates, lists and plurals are formatted through @scalius/shared/locale-format",
    why: "one Intl layer, keyed by the reader's language and the store's country (CLDR); a hard-coded locale (en-US, en-IN, en-GB) writes a store abroad in another country's format",
    paths: [storefront, "apps/admin-v2/src", "apps/api/src", "packages/core/src", "packages/shared/src", "packages/plugin-sdk/src", "plugins"],
    allow: {
      "packages/shared/src/locale-format.ts": "the layer itself",
      "packages/shared/src/locale-words.ts": "the layer's lists, plurals, relative times and units",
      "packages/shared/src/store-defaults.ts": "checks that the runtime knows a time zone",
      "apps/admin-v2/src/lib/time-zone-options.ts": "names about 600 zones once each for the picker's search, which would only churn the layer's cache",
    },
    forbid: [/\bIntl\.(?:NumberFormat|DateTimeFormat|RelativeTimeFormat|PluralRules|ListFormat)\s*\(/, /\.toLocale(?:Date|Time)?String\(/],
    sample: 'const total = new Intl.NumberFormat("en-IN").format(amount);',
  },
  {
    rule: "storefront scripts write a buyer's words from the page's catalogue, never an English literal",
    why: "a script that sets text or a label to an English string shows English on a Bangla store; markup words are checked by buyerEnglishViolations, script words here (apps/storefront/src/lib/*-copy.ts, or a data attribute the page fills)",
    paths: [storefront, "plugins"],
    extensions: [".ts", ".tsx", ".astro"],
    forbid: [
      /\.(?:textContent|innerText|placeholder|title|ariaLabel)\s*=\s*["'`][^"'`$]*[A-Za-z]{3,}/,
      /setAttribute\(\s*["'](?:aria-label|aria-description|title|placeholder|alt)["']\s*,\s*["'`][^"'`$]*[A-Za-z]{3,}/,
    ],
    sample: 'status.textContent = "This action could not be completed. Try again.";',
  },
  {
    rule: "storefront money is formatted through @/lib/currency, never the shared formatters directly",
    why: "the storefront wrapper writes amounts in the page's digits (৳১,৭৫০ on a Bangla page); the shared formatters default to Latin digits, so a direct import mixes digit systems on one page",
    paths: [storefront],
    allow: { "apps/storefront/src/lib/currency.ts": "the wrapper itself" },
    forbid: [/import\s*\{[^}]*\bformat(?:Money|Price)\b[^}]*\}\s*from\s*["']@scalius\/shared\/currency["']/],
    sample: 'import { formatMoney } from "@scalius/shared/currency";',
  },
  {
    rule: "storefront templates, order numbers and counts are written in the page's digits through @/lib/checkout-text and @/lib/store-time-zone",
    why: "the shared template filler writes a number with String(n) and the shared order number is Latin, so a Bangla page read '1টি কিনলে', 'অর্ডার #1105' and a cart badge '1' (apps/storefront/src/lib/checkout-text.ts)",
    paths: [storefront],
    allow: { "apps/storefront/src/lib/checkout-text.ts": "the wrapper itself" },
    forbid: [
      /import\s*\{[^}]*\b(?:formatCheckoutLanguageText|formatOrderNumber|formatBdMobile)\b[^}]*\}\s*from\s*["']@scalius\/shared\/(?:checkout-language(?:-format)?|order-utils|phone-input)["']/,
      /\.textContent\s*=[^;\n]*\bString\(\s*[A-Za-z_$][\w$.]*\s*\)/,
      // A number made text before it fills a template: String(n), `${n}` or `${n}%`, n.toFixed().
      /checkoutText\([^;\n]*:\s*(?:String\(|`\$\{[^}`]+\}%?`)/,
      /checkoutText\([^;\n]*\.toFixed\(/,
      /=>\s*String\(Math\./,
    ],
    sample: 'badge.textContent = String(count);',
  },
  {
    rule: "every order-status surface words its tracker, updates and shipments through presentOrderTracking",
    why: "order success relabelled the API's English steps without wording them by key, so a Bangla receipt read 'Order placed / Confirmed / On its way' while /track-order read Bangla (apps/storefront/src/lib/account-format.ts)",
    paths: [storefront],
    allow: {
      "apps/storefront/src/lib/account-format.ts": "presentOrderTracking itself",
      "apps/storefront/src/lib/order-line-groups.ts": "the pickup and no-delivery relabelling it calls",
    },
    forbid: [/\b(?:wordOrderTracking|relabelOrderProgress|relabelOrderTimeline)\(/],
    sample: "const progress = relabelOrderProgress(tracking.progress, order, copy);",
  },
  {
    rule: "a storefront component that reads its request's language writes its counts in that language",
    why: "formatCount reads the page language the layout seeded, so a card rendered on its own (a fragment, a test render) read '১২৮টি' as '128টি' beside a Bangla rating; a component holding the request's language passes it (formatPageNumber(n, language)); browser scripts after <script keep formatCount",
    paths: [storefront],
    extensions: [".astro"],
    forbid: [/^(?=[\s\S]*\bcurrentRequestTheme\()(?:(?!<script)[\s\S])*?\bformatCount\(/],
    sample: 'const { language } = await currentRequestTheme(Astro.locals);\nconst shown = formatCount(count);\n',
  },
  {
    rule: "storefront pages keep no unload or beforeunload listener, so Back restores them from the back/forward cache",
    why: "an unload listener, and in Firefox a beforeunload one, makes a page ineligible for the back/forward cache, so Back reloads it; the lazy-script loader once added one on every page (apps/storefront/src/scripts/lazy-script.ts listens only for the moment a stale page reloads)",
    paths: [storefront, "plugins"],
    allow: { "apps/storefront/src/scripts/lazy-script.ts": "listens only from a stale page's reload to its notice, then removes the listener" },
    forbid: [/addEventListener\(\s*["'](?:before)?unload["']/, /\bon(?:before)?unload\s*=/],
    sample: 'window.addEventListener("beforeunload", () => { leaving = true; });',
  },
  {
    rule: "a saved order's money and free-line presentation is defined once, in @scalius/shared/order-money-presentation",
    why: "the dashboard and storefront each kept a copy (order-tax-presentation.ts) and the copies drifted: the receipt showed a free gift at full price while the dashboard and invoice showed it free",
    paths: [storefront, "apps/admin-v2/src", "apps/api/src", "packages/core/src"],
    forbid: [/\b(?:function\s+|(?:const|let|var)\s+)(?:resolveSavedOrderMoneySummary|hasSavedOrderLineMoney|resolveSavedOrderLineMoney|isFreeOrderLine)\b/],
    sample: "export function resolveSavedOrderMoneySummary(order) { return null; }",
  },
  {
    rule: "a count handed to a dashboard message is the number, never formatNumber(count)",
    why: "t() writes a number in the store's format and picks the plural word from it; a pre-formatted string ('1,200') has no plural category and the dashboard once printed the raw plural text (apps/admin-v2/src/i18n/index.ts)",
    paths: ["apps/admin-v2/src"],
    forbid: [/\b(?:count|rows|images|skus|units|variants):\s*formatNumber\(\s*[^(),]+\)/],
    sample: 't("products", { count: formatNumber(total) })',
  },
  {
    rule: "dashboard provider secrets use SecretInput, never a bare password field",
    why: "browsers ignore autocomplete=off on password fields: a GA4 API secret filled with the staff member's saved dashboard password (Save would have sent it to Google) and their email landed in the settings search (apps/admin-v2/src/components/admin/shared/SecretInput.tsx)",
    paths: ["apps/admin-v2/src"],
    allow: {
      "apps/admin-v2/src/components/admin/shared/SecretInput.tsx": "the field itself",
      "apps/admin-v2/src/components/admin/account-settings/TwoFactorSetup.tsx": "confirms the staff member's own password (current-password)",
    },
    forbid: [/type=["']password["']/],
    sample: '<Input id="ga4-api-secret" type="password" autoComplete="off" />',
  },
  {
    rule: "dashboard values compare through sameFormValue (useFormDirty for react-hook-form), never JSON.stringify",
    why: "a JSON string is key-order sensitive and turns NaN, files and dates into look-alikes, so a draft rebuilt in another key order stayed dirty after its edits were undone (apps/admin-v2/src/lib/form-values.ts; apps/admin-v2/DESIGN.md, Saving)",
    paths: ["apps/admin-v2/src"],
    forbid: [/[!=]==\s*JSON\.stringify\(/, /JSON\.stringify\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\s*[!=]==/],
    sample: "const dirty = JSON.stringify(draft) !== JSON.stringify(saved);",
  },
  {
    rule: "storefront never imports server-only packages (@scalius/core, @scalius/database)",
    why: "the storefront Worker must not bundle domain services or database credentials",
    paths: [storefront],
    forbid: [/from\s+["']@scalius\/(?:core|database)(?:\/|["'])/, /import\(\s*["']@scalius\/(?:core|database)/],
    sample: 'import { getDb } from "@scalius/database/client";',
  },
  {
    rule: "storefront and dashboard code read only the bundler's built-in import.meta.env flags, never process.env",
    why: "the build replaces any other import.meta.env name with its local value, and a bare import.meta.env (even in a comment) with every variable the file names; runtime values come from the Worker env or the API (apps/storefront/integrations/build-env-isolation.mjs)",
    paths: [storefront, "apps/admin-v2/src"],
    forbid: [/\bimport\.meta\.env\b(?!\.(?:DEV|PROD|SSR|MODE|BASE_URL)\b)/, /\bprocess\.env\b/],
    sample: "const secret = import.meta.env.SCALIUS_SECRET;",
  },
  {
    rule: "@scalius/database and @scalius/shared are imported by subpath only",
    why: "the packages have no root export; a root import breaks the Worker bundle",
    paths: ["apps/api/src", storefront, "apps/admin-v2/src", "packages/core/src", "packages/cli/src"],
    forbid: [/from\s+["']@scalius\/(?:database|shared)["']/],
    sample: 'import { schema } from "@scalius/database";',
  },
  {
    rule: "@scalius/core domains are imported only through their entries (@scalius/core/modules/<domain> or /browser)",
    why: "a domain's index.ts and browser.ts are its public API; deeper paths couple callers to internals (packages/core/package.json exports nothing else)",
    paths: ["apps/api/src", "apps/admin-v2/src", "packages/core/src", "packages/cli/src"],
    forbid: [/["']@scalius\/core\/modules\/[^/"']+\/(?!browser["'])[^"']*["']/],
    sample: 'import { listOrders } from "@scalius/core/modules/orders/admin/list";',
  },
  {
    rule: "the dashboard imports @scalius/core domains only through their browser entries",
    why: "a domain index carries database, provider SDK and Worker code; browser.ts is the pure, closed subset the dashboard may compile and bundle",
    paths: ["apps/admin-v2/src"],
    forbid: [/from\s+["']@scalius\/core\/modules\/[^/"']+["']/],
    sample: 'import type { OrderListItem } from "@scalius/core/modules/orders";',
  },
  {
    rule: "storefront and dashboard code never import the address metadata table (@scalius/shared/address-metadata*)",
    why: "the whole libaddressinput table stays in the API Worker, which serves one country's rules at a time (GET /api/v1/address-rules/{countryCode}); browser code imports @scalius/shared/address only (MARKETS-DESIGN step 3a)",
    paths: [storefront, "apps/admin-v2/src"],
    forbid: [/["']@scalius\/shared\/address-metadata/],
    sample: 'import { addressRulesFor } from "@scalius/shared/address-metadata";',
  },
  {
    rule: "checkout payment handlers, the payment methods' presentation, the no-JavaScript order form (lib/cart/server.ts) and the account order card form write no buyer words: each failure or name is a checkout-language key",
    why: "the handlers' English (\"Cash on delivery\", \"Payment form not ready\", Stripe's own messages) reached Bangla buyers at payment, and so did the cart server's and the account card form's; the page's checkout language (en + bn presets, merchant edits) is the one source, through CheckoutCopyError and handlers/failure.ts",
    paths: [`${storefront}/lib/checkout/handlers`, `${storefront}/lib/checkout/gateway-presentation.ts`, `${storefront}/lib/cart/server.ts`, `${storefront}/lib/account-order-detail.ts`],
    forbid: [
      // A sentence or a capitalised word where a buyer reads it (copy keys are camelCase words).
      /\b(?:error|label|desc|description|buyerLabel|message|title)\s*:\s*(?:["'`][A-Z]|["'`][^"'`\n]*\s[^"'`\n]*["'`])/,
      // A raw error or provider message handed to the buyer.
      /\berror\s*:\s*[\w.?]*\.message\b/,
      /\bthrow new Error\(/,
    ],
    sample: 'return { success: false, error: "Payment form not ready. Please wait a moment." };',
  },
  {
    rule: "storefront never puts receipt proof or bearer tokens in URLs or DOM attributes",
    why: "receipt proof travels only in httpOnly cookies and API headers/bodies; URLs and DOM leak to history, referrers, analytics",
    paths: [storefront],
    forbid: [
      /searchParams\.(?:set|append)\(\s*["'`](?:token|receipt_?token|receiptToken|receiptProof|proof)["'`]/,
      /[?&](?:receipt_?token|receiptToken|receiptProof)=/i,
      /data-[\w-]*receipt-?(?:token|proof)[\w-]*=/i,
      /data-[\w-]+=\{[^}]*\breceipt(?:Token|Proof)\b/,
    ],
    sample: "url.searchParams.set(\"receiptToken\", receiptToken);",
  },
  {
    rule: "inline scripts and JSON-LD are serialized with serializeJsonForInlineScript, never raw JSON.stringify",
    why: "raw JSON.stringify lets merchant/product text close the <script> element (stored XSS)",
    paths: [storefront],
    extensions: [".astro"],
    forbid: [/set:html=\{[^}]*\bJSON\.stringify/, /\w*Json(?:Ld)?\s*=[^;]{0,200}?\bJSON\.stringify\(/],
    sample: "const productJsonLd = JSON.stringify(schema);",
  },
  {
    rule: "server-rendered script values use serializeJsonForInlineScript before template interpolation",
    why: "JSON quoting does not stop an HTML parser from closing a script element inside merchant-controlled text",
    paths: [storefront],
    allow: {
      "apps/storefront/src/components/product/scripts/product-desktop-zoom-controller.ts": "JSON quotes a CSS url(), never HTML or JavaScript",
      "apps/storefront/src/gallery/navigation.mjs": "the dev-only script ID has a bounded alphanumeric validation with closing-tag regression coverage",
      "apps/storefront/src/lib/checkout/shipping-methods.ts": "JSON appears only in a private announcement deduplication key",
      "apps/storefront/src/lib/extensions/host.ts": "JSON appears only in a render-cache lookup key",
      "apps/storefront/src/lib/product-card-layout.ts": "JSON appears only in a layout-cache lookup key",
      "apps/storefront/src/store/cart.ts": "sorted JSON compares persisted cart state; it is never embedded in HTML or a script",
    },
    forbid: [/\$\{\s*JSON\.stringify\s*\(/],
    sample: 'return `window.config=${JSON.stringify(value)};`;',
  },
  {
    rule: "email shape checks use the linear shared text scanner, never unbounded overlapping regex classes",
    why: "an invalid address with many domain dots makes repeated domain and suffix classes backtrack quadratically; the shared scanner preserves each form's validation options",
    paths: [storefront, "apps/admin-v2/src", "apps/api/src", "packages/core/src", "packages/shared/src", "packages/plugin-sdk/src", "plugins"],
    forbid: [/\[[^\]\r\n]*\](?:\+|\*|\{\d+,\})@\[[^\]\r\n]*\](?:\+|\*|\{\d+,\})\\\./],
    sample: String.raw`const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;`,
  },
  {
    rule: "URL and pathname suffixes use the linear shared text scanner, never an unanchored repeated suffix regex",
    why: "a long run of slashes or dots before a final different character makes a suffix regex restart at every position; trimTrailingCharacter scans only the actual suffix",
    paths: ["apps/storefront/src", "apps/admin-v2/src", "apps/api/src", "packages/core/src", "packages/shared/src", "packages/plugin-sdk/src", "plugins"],
    forbid: [
      /\/\\[/.]\+\$\/[dgimsuvy]*/,
      /\/\^\\\/\+\|\\\/\+\$\/[dgimsuvy]*/,
    ],
    sample: String.raw`return pathname.replace(/\/+$/, "");`,
  },
  {
  rule: "merchant field values use the bounded shared pattern matcher, never a native whole-pattern constructor",
  why: "small merchant patterns can backtrack exponentially even on short values; the shared matcher bounds state expansion and total evaluated work",
  paths: [
    "packages/shared/src/custom-fields.ts",
    "packages/shared/src/plugins/objects.ts",
    "packages/shared/src/plugins/object-patterns.ts",
    "apps/admin-v2/src/components/admin/custom-fields/custom-field-draft.ts",
    "packages/plugin-sdk/src/testing.ts",
  ],
  forbid: [/\bRegExp\s*\(/],
  sample: 'const expression = new RegExp(pattern, "u");',
  },
  {
    rule: "template variable parsing trims names after matching a disjoint brace body",
    why: "leading and trailing whitespace repetitions overlap the unrestricted variable body, so an unterminated placeholder can backtrack cubically",
    paths: ["apps/storefront/src", "apps/admin-v2/src", "apps/api/src", "packages/core/src", "packages/shared/src", "packages/plugin-sdk/src", "plugins"],
    forbid: [/\\\{\\\{\\s\*\(\[\^\{\}\][+*]\??\)\\s\*/],
    sample: String.raw`const VARIABLE = /\{\{\s*([^{}]*?)\s*\}\}/g;`,
  },
  {
    rule: "unbounded filename, address and per-line whitespace suffixes use the linear shared text scanner",
    why: "mixed trailing character classes can restart at every character of a long interior run before failing; scan the suffix once",
    paths: ["packages/shared/src/digital.ts", "packages/shared/src/address-metadata.ts", "packages/core/src/modules/warranty/policies.ts"],
    forbid: [
      /\/\^\[\.\\s\]\+\|\[\.\\s\]\+\$\/[dgimsuvy]*/,
      /\/\^\[,\\-–\\s\]\+\|\[,\\-–\\s\]\+\$\/[dgimsuvy]*/,
      /\/\[ \\t\]\+\$\/[dgimsuvy]*m[dgimsuvy]*/,
    ],
    sample: String.raw`input.terms.replace(/[ \t]+$/gm, "");`,
  },
  {
    rule: "catalog feed diagnostics reuse the live feed's eligibility and row projection",
    why: "duplicated assignment, price, image and availability checks can mark an item ready even when the feed omits it",
    paths: ["packages/core/src/modules/catalog/feed-diagnostics.ts"],
    require: [/publicProductHasBuyerResolvableSku\s*\(/, /projectCatalogFeedRows\s*\(/],
    forbid: [/calculateCatalogFeedDiscountedAmount\s*\(/, /isPositiveCatalogFeedAmount\s*\(/],
    sample: "const ready = Boolean(variant.optionCombinationKey);",
  },
  {
    rule: "sensitive storefront forms (auth OTP, cart checkout, payment recovery, product buyer inputs) submit with method=post",
    why: "phone, OTP, cart, discount, payment and buyer-input values must not enter URLs before hydration or without JavaScript",
    paths: [
      `${storefront}/components/AuthModal.tsx`,
      `${storefront}/pages/cart.astro`,
      `${storefront}/pages/payment-recovery.astro`,
      `${storefront}/components/product/ProductBuyerInputs.astro`,
      `${storefront}/components/conversation/ConversationReplyForm.astro`,
      `${storefront}/pages/account/inbox/index.astro`,
      `${storefront}/lib/account-downloads.ts`,
      // Gift-card codes (Wave B §11.1): checkout apply, balance check, save and reveal.
      `${storefront}/components/checkout/CheckoutPaymentStep.astro`,
      `${storefront}/pages/gift-card-balance.astro`,
      `${storefront}/pages/account/gift-cards.astro`,
    ],
    forbid: [/<form\b(?![^>]*\bmethod=["']post["'])/i],
    require: [/<form\b[^>]*\bmethod=["']post["']/i],
    sample: '<form action="/cart" class="x">',
  },
  {
    rule: "Wave B buyer forms (reviews, downloads and licence keys, gift cards, warranty claims) submit with method=post",
    why: "review text, gift-card codes, receipt-scoped actions and claim details must not enter URLs before hydration or without JavaScript (Wave B §11.1); files land slice by slice, so a missing one is skipped until its slice ships",
    optionalPaths: true,
    paths: [
      // Reviews (B2)
      `${storefront}/components/order/ReviewLineAction.astro`,
      `${storefront}/components/order/review-line-action.ts`,
      `${storefront}/pages/account/reviews.astro`,
      `${storefront}/lib/account-reviews.ts`,
      `${storefront}/components/product/reviews`,
      // Digital goods (B3)
      `${storefront}/components/order/DigitalLineDelivery.astro`,
      `${storefront}/components/order/digital-line-delivery.ts`,
      `${storefront}/pages/account/downloads.astro`,
      // Gift cards (B4)
      `${storefront}/components/order/GiftCardLineDelivery.astro`,
      `${storefront}/components/order/gift-card-line-delivery.ts`,
      `${storefront}/pages/account/gift-cards.astro`,
      `${storefront}/pages/gift-card-balance.astro`,
      `${storefront}/pages/checkout.astro`,
      `${storefront}/components/checkout`,
      // Warranty (B5)
      `${storefront}/components/order/WarrantyLineInfo.astro`,
      `${storefront}/components/order/warranty-line-info.ts`,
      `${storefront}/pages/account/warranties.astro`,
      // The guest order lookup that leads to every receipt-scoped form above.
      `${storefront}/pages/track-order.astro`,
    ],
    forbid: [/<form\b(?![^>]*\bmethod=["']post["'])/i],
    sample: '<form action="/account/reviews" class="x">',
  },
  {
    rule: "storefront analytics, buyer event and Meta CAPI builders never read cart-line buyer inputs (properties)",
    why: "engraving text, notes and gift messages are buyer content; they must never reach pixels, tag managers or the Conversions API (Wave A P6)",
    paths: [
      `${storefront}/lib/analytics.ts`,
      `${storefront}/lib/tracking/meta-capi.ts`,
      `${storefront}/lib/buyer-events/lines.ts`,
      `${storefront}/lib/buyer-events/listing.ts`,
      `${storefront}/lib/buyer-events/pixels.ts`,
    ],
    forbid: [/\bproperties\b/],
    sample: "contents: items.map((item) => ({ id: item.id, properties: item.properties })),",
  },
  {
    rule: "the agent continuation page renders without the storefront Layout",
    why: "a bearer-bound continuation page must not load merchant analytics or third-party head/body scripts",
    paths: [`${storefront}/pages/agent/continue/[continuationId].astro`],
    forbid: [/layouts\/Layout(?:\.astro)?["']/],
    sample: 'import Layout from "@/layouts/Layout.astro";',
  },
  {
    rule: "agent credential, pairing, and OAuth-consent modules never log",
    why: "these handle PATs, pairing codes, and OAuth grants; any console call risks writing a bearer secret to logs",
    paths: [
      "apps/api/src/routes/admin/agent-access.ts",
      "apps/api/src/routes/agent-auth.ts",
      "apps/api/src/agent-access/pat.ts",
      "apps/api/src/agent-access/oauth-consent.ts",
      "packages/core/src/modules/agent-access/agent-access.service.ts",
    ],
    forbid: [/\bconsole\.\w+\s*\(/],
    sample: "console.log(token);",
  },
  {
    rule: "admin shipment status routes never call the carrier status sync directly",
    why: "carrier sync mutates order status and stock; every status route must use checkAndSyncShipmentStatus (shipment-status-sync.ts)",
    paths: ["apps/api/src/routes/admin/orders-status.ts"],
    forbid: [/\b(?:checkShipmentStatus|updateOrderStatusFromShipment)\s*\(/],
    sample: "await updateOrderStatusFromShipment(db, shipment);",
  },
  {
    rule: "customer support requests and conversations never mutate payments, stock, delivery, or order status",
    why: "a buyer-submitted request or message is a record for staff review, never an automatic refund/cancel/restock (Wave A C5)",
    paths: [
      "packages/core/src/modules/orders/order-support-requests.ts",
      "packages/core/src/modules/conversations",
      // Warranty claims are records plus a thread (Wave B W5); remedies go
      // through returns, refunds or manual orders in their own domains.
      "packages/core/src/modules/warranty",
    ],
    forbid: [
      /from\s+["']\.\.\/(?:inventory|delivery|fulfillment|fulfilment|checkout)(?:\/|["'])/,
      /from\s+["']\.\.\/payments\/(?!refund-attempt-visibility["'])/,
      /\b(?:processRefund|createRefund|initiateSSLCommerzRefund|updateOrderStatus\w*|deductStock|reserveStock\w*|releaseReservedStock\w*|restoreDeductedStock|adjustStock|setStock)\s*\(/,
    ],
    sample: 'import { restoreDeductedStock } from "../inventory/restore";',
  },
  {
    rule: "warranty claims never write money, stock or order state (W5)",
    why: "a claim is a record plus a thread; a repair, replacement or refund goes through the order's own refund, return or manual-order flows (Wave B §5.2), so the warranty domain and its routes write only warranty and conversation rows",
    paths: [
      "packages/core/src/modules/warranty",
      "apps/api/src/routes/admin/warranty-claims.ts",
      "apps/api/src/routes/admin/orders/warranty-claims.ts",
      "apps/api/src/routes/customer-auth/warranties.ts",
      "apps/api/src/routes/storefront-orders/warranties.ts",
    ],
    forbid: [
      /\.(?:insert|update|delete)\(\s*(?:orders|orderItems|orderFulfillments|orderFulfillmentLines|payments|refunds\w*|productVariants|inventory\w*|stock\w*|giftCard\w*)\s*\)/,
      /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+[`"]?(?:orders|order_items|order_fulfillments|order_fulfillment_lines|payments|refunds|product_variants|inventory_\w+|gift_card\w*)\b/i,
      /\bfrom\s+["']@scalius\/core\/modules\/(?:payments|inventory|checkout|gift-cards|returns)(?:\/|["'])/,
    ],
    sample: "await db.update(orders).set({ status: \"refunded\" });",
  },
  {
    rule: "order_items.fulfilled_quantity moves only through the fulfilment ledger",
    why: "fulfilled_quantity is a trigger projection of active order_fulfillment_lines (Wave A F1); a direct update desynchronises it from the ledger",
    paths: ["apps/api/src", "packages/core/src"],
    forbid: [
      /\.set\(\s*\{[^}]*\bfulfilledQuantity\s*:/,
      /\bSET\s+[^;`]*\bfulfilled_quantity\s*=/i,
    ],
    sample: "await db.update(orderItems).set({ fulfilledQuantity: 3 }).where(eq(orderItems.id, id));",
  },
  {
    rule: "conversations never write customers or orders",
    why: "posting or starting a thread must not create or change a customer or an order contact; unverified contacts never change identity (Wave A C2)",
    paths: ["packages/core/src/modules/conversations"],
    forbid: [/\.(?:insert|update|delete)\(\s*(?:customers|orders|customerHistory)\s*\)/],
    sample: "await db.update(customers).set({ email });",
  },
  {
    rule: "review stats and gift-card balances move only through their trigger projections",
    why: "product_review_stats is a projection of published reviews (Wave B R3) and gift_cards.balance_minor of the append-only transaction ledger (G1); a direct write desynchronises them",
    paths: ["apps/api/src", "packages/core/src"],
    forbid: [
      /\.(?:insert|update|delete)\(\s*productReviewStats\s*\)/,
      /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+[`"]?product_review_stats\b/i,
      /\.set\(\s*\{[^}]*\bbalanceMinor\s*:/,
      /\bSET\s+[^;`]*\bbalance_minor\s*=/i,
    ],
    sample: "await db.update(productReviewStats).set({ reviewCount: 0 });",
  },
  {
    rule: "gift-card, digital-goods and review code never logs codes, keys or review text",
    why: "gift-card codes and licence keys are bearer value, and review text is buyer content; logs carry ids, last4 and masked contacts only (Wave B R6, D7, G6)",
    paths: [
      "packages/core/src/modules/gift-cards",
      "packages/core/src/modules/digital",
      "packages/core/src/modules/reviews",
      "apps/api/src/notification-content",
    ],
    forbid: [/\bconsole\.\w+\s*\([^)]*\b(?:code|codes|licenceKey|licenceKeys|keyPlaintext|plaintext|body|title)\b/],
    sample: 'console.warn("gift card redeem failed", code);',
  },
  {
    rule: "an outbound request URL never puts a secret into its query string (access_token, api_key, apikey, token, key) by interpolation, concatenation or searchParams",
    why: "a query string lands in provider and proxy access logs, error reports and traces; send the credential in an Authorization header (packages/core/src/integrations/meta/conversions-api.ts, whatsapp.ts). Rejected: a template literal `?key=${x}` / `&token=${x}`, a string concatenation `\"?access_token=\" + x`, and `url.searchParams.set/append(\"token\", x)`. A URL fragment (#token=) is never sent, so it is outside this check",
    paths: ["apps/api/src", "apps/admin-v2/src", storefront, "packages/core/src", "packages/shared/src", "packages/plugin-sdk/src", "packages/cli/src", "plugins"],
    optionalPaths: ["plugins", "packages/cli/src"],
    allow: {
      "packages/core/src/modules/customer-marketing/links.ts": "builds the signed ?token= confirm and unsubscribe links the platform emails to its own customers (rules/privacy/sensitive-values-never-in-urls.md); each does one consent action for one customer and no outbound request carries it",
    },
    forbid: [
      /[?&](?:access_token|api_key|apikey|token|key)=\$\{/i,
      /[?&](?:access_token|api_key|apikey|token|key)=["'`]\s*\+/i,
      /\bsearchParams\s*\.\s*(?:set|append)\(\s*["'`](?:access_token|api_key|apikey|token|key)["'`]\s*,/i,
    ],
    sample: "const url = `https://graph.facebook.com/v1/${id}/events?access_token=${accessToken}`;",
  },
  {
    rule: "production code never calls the legacy multi-SKU stock helpers",
    why: "deductMultiple/releaseMultiple/restoreDeductedMultiple bypass the ledger-v2 stockVersion CAS batch",
    paths: ["apps/api/src", "packages/core/src"],
    forbid: [/(?<!function\s+)\b(?:deductMultiple|releaseMultiple|restoreDeductedMultiple)\s*\(/],
    sample: "await deductMultiple(db, items);",
  },
  {
    rule: "orders are never hard-deleted",
    why: "orders own payment, refund, and inventory audit history; they are archived, not deleted",
    paths: ["apps/api/src", "packages/core/src"],
    forbid: [/\.delete\(\s*orders\s*\)/],
    sample: "await db.delete(orders).where(eq(orders.id, id));",
  },
  {
    rule: "core feature code is provider-neutral: no drizzle-orm/d1 or D1Database",
    why: "D1, Turso, and PostgreSQL share one Database client; D1-only code breaks the other providers",
    paths: ["packages/core/src"],
    forbid: [/["']drizzle-orm\/d1["']/, /\bD1Database\b/],
    sample: 'import { drizzle } from "drizzle-orm/d1";',
  },
  {
    rule: "SQL matches a value with containsText/startsWithText (@scalius/core/utils/text-match), never a LIKE or GLOB pattern built from it",
    why: "D1 refuses a LIKE/GLOB pattern over 50 bytes, bound values included: a 17-letter Bangla search or a long derived handle fails only on D1; a fixed literal pattern is fine",
    paths: ["apps/api/src", "packages/core/src", "plugins"],
    forbid: [/\b(?:LIKE|GLOB)\s+(?:\$\{|'%'\s*\|\|)/i, /\b(?:not)?(?:[iI]l|l)ike\(\s*[^,()]+,(?!\s*["'][^"'`$]*["']\s*\))/],
    sample: "conditions.push(like(products.name, `%${search}%`));",
  },
  {
    rule: "a lower()/trim() expression matched against a json_each() list reads bare values, never SELECT CAST(value AS TEXT)",
    why: "SQLite uses an expression index (lower(trim(email)), the SKU and barcode identities) for `expr IN (SELECT value FROM json_each(?))` but scans the table once the list is CAST: a customer import read every customer per chunk (store-transfer/customer-import.ts); json_each values of a string list are already TEXT on every provider",
    paths: ["apps/api/src", "packages/core/src", "packages/database/src"],
    forbid: [/\b(?:lower|trim|upper)\((?:[^()]|\([^()]*\))*\)\s*IN\s*\(\s*SELECT\s+CAST\(\s*value\s+AS\s+TEXT\s*\)/i],
    sample: "sql`lower(trim(${customers.email})) IN (SELECT CAST(value AS TEXT) FROM json_each(${emails}))`",
  },
  {
    rule: "an id list bound as one json_each() value beside a live-row filter writes the filter +deleted_at",
    why: "without planner statistics (D1 keeps none) SQLite estimates a json_each list as large and walks every live row on a deleted_at-led index (products_list_price_idx, customers_list_name_idx) instead of seeking the list; `+deleted_at IS NULL` keeps it a filter (collections.service.ts, customer-tags.ts). A list bound as parameters (inArray) is planned on its index already",
    paths: ["apps/api/src", "packages/core/src"],
    allow: Object.fromEntries([
      ["packages/core/src/modules/store-transfer/product-export.ts", "Its child lookups match the product id list on (product_id, deleted_at) indexes, which seek the list and the live filter together; the product page itself writes +deleted_at (import-lookup-plans.d1.test.ts)."],
      ["packages/core/src/modules/store-transfer/product-images.ts", "The variant image update leads with product_id = ? on (product_id, deleted_at), which seeks before the id list applies."],
      ...[
      "packages/core/src/modules/settings/site-settings.service.ts",
      "packages/core/src/modules/storefront/theme-handles.ts",
      "packages/core/src/modules/price-lists/market-pricing.ts",
      "packages/core/src/modules/price-lists/price-lists.service.ts",
      "packages/core/src/modules/catalog/compare.ts",
      "packages/core/src/modules/catalog/public-sku-cards.ts",
      "packages/core/src/modules/checkout/cart-validation.ts",
      "packages/core/src/modules/product-admin/read.ts",
      "packages/core/src/modules/product-admin/semantic-sections.ts",
      "packages/core/src/modules/product-admin/option-matrix.ts",
      "packages/core/src/modules/product-admin/write.ts",
      "packages/core/src/modules/attributes/attributes.service.ts",
      "packages/core/src/modules/inventory/inventory.service.ts",
      "packages/core/src/modules/inventory/reserve.ts",
      "packages/core/src/modules/delivery/zones.ts",
      ].map((file) => [file, "Not yet swept: each lookup needs its own plan check (some lists drive a joined table, or a unique column outranks the deleted_at index); the sweep follows, file by file, and removes the entry."]),
    ]),
    forbid: [
      /(?:IN\s*\(\s*SELECT\s+(?:CAST\(\s*value\s+AS\s+TEXT\s*\)|value)\s+FROM\s+json_each\(|inJsonArray\()[^;]{0,300}?(?<![+\w])(?:isNull\(\s*\w+\.deletedAt\s*\)|\$\{\s*\w+\.deletedAt\s*\}\s+IS\s+NULL)/i,
      /(?<![+\w])(?:isNull\(\s*\w+\.deletedAt\s*\)|\$\{\s*\w+\.deletedAt\s*\}\s+IS\s+NULL)[^;]{0,300}?(?:IN\s*\(\s*SELECT\s+(?:CAST\(\s*value\s+AS\s+TEXT\s*\)|value)\s+FROM\s+json_each\(|inJsonArray\()/i,
    ],
    sample: "db.select().from(products).where(and(sql`${products.id} IN (SELECT value FROM json_each(${ids}))`, isNull(products.deletedAt)))",
  },
  {
    rule: "a JSON path in SQL is $.name(.name)*: no array index, no quoted or punctuated member",
    why: "PostgreSQL runs SQLite's JSON readers (json_extract, json_each, json_type, json_array_length) through scalius_compat.json_path_value, which takes '$.name' paths only: any other path compiles and then fails every call on PostgreSQL alone (a refund's settlement guard and the related-objects read did). Bind objects and read members by name, or walk an array with json_each and its key. PostgreSQL's json_set, json_insert, json_replace and json_remove take indexes and quoted members too, but code keeps one path form for reads and writes",
    paths: ["apps/api/src", "packages/core/src", "packages/database/src", "plugins"],
    forbid: [
      // A path literal (quoted, or a template, bound or inline) that starts with an index: '$[0]', `$[${i}]`.
      /(['"`])\$\[/,
      JSON_MEMBER_PATH_LITERAL,
    ],
    sample: "WHERE json_extract(seen.value, '$[0]') = ra.id",
  },
  {
    rule: "request-scoped state never lives in known module globals",
    why: "Workers reuse isolates across requests and merchants; cached auth/clients/URLs leak between them",
    paths: [
      "packages/core/src/auth/auth.ts",
      "packages/core/src/auth/rbac/auto-seed.ts",
      "packages/core/src/auth/rbac/helpers.ts",
      "packages/core/src/integrations/firebase/admin.ts",
      "packages/core/src/integrations/storage.ts",
      "packages/core/src/integrations/email/provider.ts",
      "packages/core/src/modules/payments/gateways/stripe.ts",
    ],
    // `let` caches are caught by the mutable-module-variable check below.
    forbid: [/\bcachedEnvSignature\b|const permissionCache = new Map|\binitPublicMediaUrl\b|new InMemoryCache|const memCache/],
    sample: "const memCache = new Map();",
  },
  {
    rule: "API requests establish the async media presentation context",
    why: "the public media URL is per request; without the context it falls back to module state",
    paths: ["apps/api/src/runtime/base-app.ts"],
    require: [/withPublicMediaUrl\(\s*[\s\S]{1,120}?,\s*\(\) =>/],
    sample: "return next();",
  },
];

/** Worker isolates are shared across requests: no `let`/`var` at module scope. */
function mutableModuleVariables() {
  const violations = [];
  for (const file of ["apps/api/src", "packages/core/src", "packages/database/src"]
    .flatMap((path) => codeFiles(path, new Set([".ts", ".tsx"])))) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement) && !(statement.declarationList.flags & ts.NodeFlags.Const)) {
        const names = statement.declarationList.declarations.map((d) => d.name.getText(source)).join(", ");
        violations.push(`${relative(root, file)}: mutable module variable ${JSON.stringify(names)}`);
      }
    }
  }
  return violations;
}

/** Violations of one policy for the given file texts ({ name, text }). */
export function policyViolations(policy, files) {
  const violations = [];
  for (const { name, text } of files) {
    for (const pattern of policy.forbid ?? []) if (pattern.test(text)) violations.push(`${name}: matches ${pattern}`);
    for (const pattern of policy.require ?? []) if (!pattern.test(text)) violations.push(`${name}: lacks ${pattern}`);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Right-to-left readiness: logical direction utilities
// ---------------------------------------------------------------------------

/** Tailwind utilities that name a physical side, and their logical spelling. */
const PHYSICAL_UTILITY = /^-?(?:(?:ml|mr|pl|pr|left|right|scroll-m[lr]|scroll-p[lr])-.+|(?:border|rounded)-(?:[lr]|tl|tr|bl|br)(?:-.+)?|(?:text|float)-(?:left|right))$/;

/**
 * Physical utilities that are meant (file -> utilities): centring with a
 * translate, and positions measured from the left in pixels or percent.
 */
export const PHYSICAL_UTILITY_ALLOW = {
  "apps/admin-v2/src/components/ui/dialog.tsx": ["left-1/2"],
  "apps/admin-v2/src/components/admin/online-store/HeroFocalPointEditor.tsx": ["left-1/2", "left-(--focus-x)"],
  // The navigation's tooltip and flyouts sit at measured pixels beside it, on its page side in either direction.
  "apps/admin-v2/src/components/admin/layout/NavFlyouts.tsx": ["left-(--tip-x)"],
  "apps/admin-v2/src/components/admin/analytics/SalesTrendChart.tsx": ["left-(--dot-x)", "left-(--tip-edge)", "right-(--tip-edge)"],
  // The preview frame and its outlines sit at measured pixels from the canvas' left edge (the frame never mirrors).
  "apps/admin-v2/src/components/admin/online-store/theme-editor/EditorCanvas.tsx": ["left-(--ox)", "left-0", "left-1/2"],
  "apps/admin-v2/src/components/admin/online-store/theme-editor/CanvasTextEditor.tsx": ["left-(--ox)"],
  "apps/storefront/src/components/header/variants/ClassicHeader.astro": ["left-1/2"],
  "apps/storefront/src/components/sliders/CustomCarousel.astro": ["left-1/2"],
};

/** A class token's utility: the part after its variants (`md:hover:` ...) and `!`. */
function utilityOf(token) {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    else if (char === ":" && depth === 0) start = index + 1;
  }
  return { variants: token.slice(0, start), utility: token.slice(start).replace(/^!/, "") };
}

/**
 * Dashboard and storefront class names use logical sides (`ms-`, `pe-`,
 * `inset-s-`, `border-e`, `rounded-s-`, `text-start`), so a right-to-left
 * page mirrors. An `rtl:`/`ltr:` variant marks a deliberate physical pair.
 */
export function physicalUtilityViolations(files, allow = PHYSICAL_UTILITY_ALLOW) {
  const violations = [];
  for (const { name, text } of files) {
    const allowed = new Set(allow[name] ?? []);
    text.split("\n").forEach((line, index) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      for (const raw of line.match(/[^\s"'`{}]+/g) ?? []) {
        // Unwrap a token's closing parenthesis or trailing punctuation from code (`cn("ml-2")`).
        let token = raw.replace(/[,;]+$/, "");
        while (token.endsWith(")") && (token.match(/\(/g) ?? []).length < (token.match(/\)/g) ?? []).length) token = token.slice(0, -1);
        const { variants, utility } = utilityOf(token);
        if (!PHYSICAL_UTILITY.test(utility) || /(?:^|:)(?:rtl|ltr):$/.test(variants) || allowed.has(utility)) continue;
        violations.push(`${name}:${index + 1}: ${token}`);
      }
    });
  }
  return violations;
}

function collectPhysicalUtilityViolations() {
  return [storefront, "apps/admin-v2/src"]
    .flatMap((path) => codeFiles(path, new Set([".ts", ".tsx", ".astro"])))
    .flatMap((file) => physicalUtilityViolations([{ name: relative(root, file), text: readFileSync(file, "utf8") }]));
}

// ---------------------------------------------------------------------------
// Buyer words come from the storefront's English and Bangla catalogues
// ---------------------------------------------------------------------------

/** Attributes a buyer reads or a screen reader speaks. */
const BUYER_TEXT_ATTRIBUTES = new Set(["aria-label", "aria-description", "aria-roledescription", "aria-valuetext", "placeholder", "title", "alt", "label"]);
/** Text that reads the same in every language: symbols and digits, one lowercase token (a key cap, a unit), a format mask, a link or an address. */
const LANGUAGE_NEUTRAL_TEXT = /^(?:[^A-Za-z]*|[a-z][a-z0-9_-]*|[0-9X#-]{4,}|https?:\/\/\S+|[\w.+-]+@[\w.-]+)$/;
/** Names no language translates. */
const NEVER_TRANSLATED = new Set(["WhatsApp", "Messenger", "Facebook", "Instagram", "Google", "bKash", "Nagad", "Visa", "Mastercard", "PayPal", "Stripe"]);

/**
 * Storefront files whose words are not the buyer's (file -> reason), or the
 * few English values one file may hold (file -> { reason, text }).
 */
export const BUYER_ENGLISH_ALLOW = {
  "apps/storefront/src/pages/theme-preview/library.astro": "the theme editor's section library frame (staff, never buyers)",
  "apps/storefront/src/components/newsletter/NewsletterForm.astro": { reason: "the bot trap's label: hidden from people and assistive technology", text: ["Company website"] },
};

function isBuyerEnglish(raw) {
  const text = raw.replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return /[A-Za-z]{2,}/.test(text) && !LANGUAGE_NEUTRAL_TEXT.test(text) && !NEVER_TRANSLATED.has(text);
}

/**
 * Hard-coded English a buyer would read in a TSX or parsed Astro expression:
 * text between tags, a text attribute's literal, and the literal a child
 * expression or a text attribute can evaluate to (`{open ? "Close" : "Open"}`,
 * `{label ?? "Search"}`, `` {`${count} items`} ``). Calls are not followed:
 * a catalogue lookup is the way out.
 */
function jsxBuyerEnglish(source, node, report) {
  const branches = (expression) => {
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) return branches(expression.expression);
    if (ts.isConditionalExpression(expression)) return [expression.whenTrue, expression.whenFalse].forEach(branches);
    if (ts.isBinaryExpression(expression)) {
      const operator = expression.operatorToken.kind;
      if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) branches(expression.left);
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) branches(expression.right);
      return;
    }
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      if (isBuyerEnglish(expression.text)) report(expression, JSON.stringify(expression.text));
    } else if (ts.isTemplateExpression(expression)) {
      const words = [expression.head.text, ...expression.templateSpans.map((span) => span.literal.text)].join(" ");
      if (/[A-Za-z]{2,}/.test(words)) report(expression, expression.getText(source));
    }
  };
  const visit = (child) => {
    if (ts.isJsxText(child)) {
      if (isBuyerEnglish(child.text)) report(child, child.text);
    } else if (ts.isJsxExpression(child) && child.expression && (ts.isJsxElement(child.parent) || ts.isJsxFragment(child.parent))) {
      branches(child.expression);
    } else if (ts.isJsxAttribute(child) && child.initializer && BUYER_TEXT_ATTRIBUTES.has(child.name.getText(source))) {
      if (ts.isStringLiteral(child.initializer)) {
        if (isBuyerEnglish(child.initializer.text)) report(child, `${child.name.getText(source)}=${JSON.stringify(child.initializer.text)}`);
      } else if (ts.isJsxExpression(child.initializer) && child.initializer.expression) {
        branches(child.initializer.expression);
      }
    }
    ts.forEachChild(child, visit);
  };
  if (node.kind !== ts.SyntaxKind.SourceFile) branches(node);
  visit(node);
}

/**
 * The end of the `{ ... }` expression opened at `start`, skipping comments,
 * strings, templates and nested braces (an apostrophe after a letter is a
 * word's, as in JSX text: "store's").
 */
function closingBrace(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "/" && text[index + 1] === "/") {
      index = text.indexOf("\n", index);
      if (index === -1) return text.length;
    } else if (char === "/" && text[index + 1] === "*") {
      index = text.indexOf("*/", index + 2) + 1;
      if (index === 0) return text.length;
    } else if (char === "'" && /[\p{L}\p{N}]/u.test(text[index - 1] ?? "")) {
      continue;
    } else if (char === '"' || char === "'" || char === "`") {
      for (index += 1; index < text.length && text[index] !== char; index += 1) if (text[index] === "\\") index += 1;
    } else if (char === "{") depth += 1;
    else if (char === "}" && (depth -= 1) === 0) return index;
  }
  return text.length;
}

/**
 * Hard-coded buyer English in storefront TSX islands and Astro templates
 * (frontmatter, scripts and styles aside). Words come from the en + bn
 * catalogues (lib/*-copy.ts); a Bangla store otherwise shows English.
 */
export function buyerEnglishViolations(files, allow = BUYER_ENGLISH_ALLOW) {
  const violations = [];
  for (const { name, text } of files) {
    const allowed = allow[name];
    if (typeof allowed === "string") continue;
    const allowedText = new Set(allowed?.text ?? []);
    const found = [];
    const lineAt = (offset) => text.slice(0, offset).split("\n").length;
    const record = (offset, value) => {
      const words = value.replace(/\s+/g, " ").trim();
      if (!allowedText.has(words.replace(/^"|"$/g, ""))) found.push(`${name}:${lineAt(offset)}: ${words}`);
    };
    const scan = (code, offset, astroContext) => {
      const kind = name.endsWith(".tsx") || astroContext ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const source = ts.createSourceFile(name, astroContext ? `(${code}\n)` : code, ts.ScriptTarget.Latest, true, kind);
      const shift = astroContext ? offset - 1 : 0;
      const report = (node, value) => record(node.getStart(source) + shift, value);
      if (!astroContext) return jsxBuyerEnglish(source, source, report);
      const statement = source.statements[0];
      if (!statement || !ts.isExpressionStatement(statement)) return;
      jsxBuyerEnglish(source, statement.expression.expression, report);
    };
    if (name.endsWith(".tsx")) {
      scan(text, 0);
    } else {
      const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(text);
      let markup = text.slice(0, frontmatter?.[0].length ?? 0).replace(/[^\n]/g, " ") + text.slice(frontmatter?.[0].length ?? 0);
      // A script or style (self-closing too: `<script set:html={json} />`) and a comment carry no buyer words.
      markup = markup.replace(/<(script|style)\b(?:[^<>]*?\/>|[^<>]*?>[\s\S]*?<\/\1>)|<!--[\s\S]*?-->/g, (block) => block.replace(/[^\n]/g, " "));
      let template = "";
      for (let index = 0; index < markup.length; index += 1) {
        if (markup[index] !== "{") {
          template += markup[index];
          continue;
        }
        const end = closingBrace(markup, index);
        const attribute = /([\w:@.-]+)=$/.exec(template.slice(-80))?.[1];
        const inTag = template.lastIndexOf("<") > template.lastIndexOf(">");
        if (!inTag) scan(markup.slice(index + 1, end), index + 1, "child");
        else if (attribute && BUYER_TEXT_ATTRIBUTES.has(attribute)) scan(markup.slice(index + 1, end), index + 1, "text-attribute");
        template += markup.slice(index, end + 1).replace(/[^\n]/g, " ");
        index = end;
      }
      for (const match of template.matchAll(/>([^<>]+)</g)) if (isBuyerEnglish(match[1])) record(match.index + 1, match[1]);
      for (const match of template.matchAll(/\s([\w:-]+)=(["'])(.*?)\2/g)) {
        if (BUYER_TEXT_ATTRIBUTES.has(match[1]) && isBuyerEnglish(match[3])) record(match.index + 1, `${match[1]}=${JSON.stringify(match[3])}`);
      }
    }
    violations.push(...found);
  }
  return violations;
}

function collectBuyerEnglishViolations() {
  // Theme plugins draw buyer pages too; their words go through t(context, { en, bn }).
  const plugins = readdirSync(resolve(root, "plugins")).map((plugin) => `plugins/${plugin}/src`).filter((path) => existsSync(resolve(root, path)));
  return [`${storefront}/components`, `${storefront}/pages`, `${storefront}/layouts`, ...plugins]
    .flatMap((path) => codeFiles(path, new Set([".tsx", ".astro"])))
    .flatMap((file) => buyerEnglishViolations([{ name: relative(root, file), text: readFileSync(file, "utf8") }]));
}

export function collectSourcePolicyViolations() {
  const violations = policies.flatMap((policy) => policyViolations(
    policy,
    policy.paths
      .filter((path) => !policy.optionalPaths || existsSync(resolve(root, path)))
      .flatMap((path) => codeFiles(path, policy.extensions ? new Set(policy.extensions) : undefined)).map((file) => ({
      name: relative(root, file),
      text: readFileSync(file, "utf8"),
    }))
      .filter((file) => !Object.hasOwn(policy.allow ?? {}, file.name)),
  ).map((violation) => `${policy.rule}\n    ${violation}`));
  return [
    ...violations,
    ...collectBuyerEnglishViolations().map((v) => `storefront buyer words come from the en + bn catalogues (apps/storefront/src/lib/*-copy.ts), so a Bangla store never shows English\n    ${v}`),
    ...collectPhysicalUtilityViolations().map((v) => `dashboard and storefront classes use logical sides (ms-, pe-, inset-s-, text-start), so right-to-left pages mirror\n    ${v}`),
    ...mutableModuleVariables().map((v) => `no mutable module state\n    ${v}`),
    ...collectCoreBoundaryViolations().map((v) => `core domain boundaries (scripts/core-boundaries.mjs)\n    ${v}`),
  ];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const violations = collectSourcePolicyViolations();
  if (violations.length > 0) {
    console.error("Source policy check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(`Source policy check: OK (${policies.length + 4} policies)`);
  }
}
