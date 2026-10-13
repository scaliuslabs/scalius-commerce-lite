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

/** Files under `path` (a file or directory), skipping tests, declarations, generated code. */
export function codeFiles(path, extensions = codeExtensions) {
  const absolute = resolve(root, path);
  if (extensions.has(extname(absolute))) return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "generated" || entry.name === "testing") return [];
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
    rule: "a count handed to a dashboard message is the number, never formatNumber(count)",
    why: "t() writes a number in the store's format and picks the plural word from it; a pre-formatted string ('1,200') has no plural category and the dashboard once printed the raw plural text (apps/admin-v2/src/i18n/index.ts)",
    paths: ["apps/admin-v2/src"],
    forbid: [/\b(?:count|rows|images|skus|units|variants):\s*formatNumber\(\s*[^(),]+\)/],
    sample: 't("products", { count: formatNumber(total) })',
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
      `${storefront}/pages/checkout.astro`,
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
    rule: "storefront analytics and Meta CAPI builders never read cart-line buyer inputs (properties)",
    why: "engraving text, notes and gift messages are buyer content; they must never reach pixels, tag managers or the Conversions API (Wave A P6)",
    paths: [
      `${storefront}/lib/analytics.ts`,
      `${storefront}/lib/tracking/meta-capi.ts`,
      `${storefront}/components/product/lib/product-analytics.ts`,
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
    why: "carrier sync mutates order status and stock; both routes must share checkAndSyncShipmentStatus (shipment-status-sync.ts)",
    paths: ["apps/api/src/routes/admin/orders-status.ts", "apps/api/src/routes/admin/shipments.ts"],
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
      "apps/api/src/utils/kv-cache.ts",
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
  "apps/admin-v2/src/components/admin/layout/AppSidebar.tsx": ["left-(--tip-x)"],
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
    console.log(`Source policy check: OK (${policies.length + 3} policies)`);
  }
}
