#!/usr/bin/env node
// The few structural rules that behaviour tests cannot express: import
// boundaries, forbidden sinks, and Worker request isolation. Everything else
// belongs in a behaviour test. Each policy carries the production rule it
// protects and a `sample` that must violate it, so a regex that silently stops
// matching fails `check-source-policies.test.mjs`.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
    if (!extensions.has(extname(entry.name)) || /\.test\.|\.d\.ts$/.test(entry.name)) return [];
    return [child];
  });
}

const storefront = "apps/storefront/src";

/**
 * paths: files or directories. forbid: no file may match any pattern.
 * require: every file must match every pattern. extensions: optional file filter.
 * sample: text that must violate the policy.
 */
export const policies = [
  {
    rule: "storefront never imports server-only packages (@scalius/core, @scalius/database)",
    why: "the storefront Worker must not bundle domain services or database credentials",
    paths: [storefront],
    forbid: [/from\s+["']@scalius\/(?:core|database)(?:\/|["'])/, /import\(\s*["']@scalius\/(?:core|database)/],
    sample: 'import { getDb } from "@scalius/database/client";',
  },
  {
    rule: "@scalius/database and @scalius/shared are imported by subpath only",
    why: "the packages have no root export; a root import breaks the Worker bundle",
    paths: ["apps/api/src", storefront, "apps/admin-v2/src", "packages/core/src", "packages/cli/src"],
    forbid: [/from\s+["']@scalius\/(?:database|shared)["']/],
    sample: 'import { schema } from "@scalius/database";',
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
    rule: "sensitive storefront forms (auth OTP, cart checkout, payment recovery) submit with method=post",
    why: "phone, OTP, cart, discount, and payment values must not enter URLs before hydration or without JavaScript",
    paths: [
      `${storefront}/components/AuthModal.tsx`,
      `${storefront}/pages/cart.astro`,
      `${storefront}/pages/payment-recovery.astro`,
    ],
    forbid: [/<form\b(?![^>]*\bmethod=["']post["'])/i],
    require: [/<form\b[^>]*\bmethod=["']post["']/i],
    sample: '<form action="/cart" class="x">',
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
    rule: "customer support requests never mutate payments, stock, delivery, or order status",
    why: "a buyer-submitted request is a record for staff review, never an automatic refund/cancel/restock",
    paths: ["packages/core/src/modules/orders/order-support-requests.ts"],
    forbid: [
      /from\s+["']\.\.\/(?:inventory|delivery|fulfillment)(?:\/|["'])/,
      /from\s+["']\.\.\/payments\/(?!refund-attempt-visibility["'])/,
      /\b(?:processRefund|createRefund|initiateSSLCommerzRefund|updateOrderStatus\w*|deductStock|reserveStock\w*|releaseReservedStock\w*|restoreDeductedStock|adjustStock|setStock)\s*\(/,
    ],
    sample: 'import { restoreDeductedStock } from "../inventory/restore";',
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
    rule: "request-scoped state never lives in known module globals",
    why: "Workers reuse isolates across requests and merchants; cached auth/clients/URLs leak between them",
    paths: [
      "packages/core/src/auth/auth.ts",
      "packages/core/src/auth/rbac/auto-seed.ts",
      "packages/core/src/auth/rbac/helpers.ts",
      "packages/core/src/integrations/firebase/admin.ts",
      "packages/core/src/integrations/storage.ts",
      "packages/core/src/integrations/email/provider.ts",
      "packages/core/src/modules/delivery/pathao-location-import.ts",
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

export function collectSourcePolicyViolations() {
  const violations = policies.flatMap((policy) => policyViolations(
    policy,
    policy.paths.flatMap((path) => codeFiles(path, policy.extensions ? new Set(policy.extensions) : undefined)).map((file) => ({
      name: relative(root, file),
      text: readFileSync(file, "utf8"),
    })),
  ).map((violation) => `${policy.rule}\n    ${violation}`));
  return [...violations, ...mutableModuleVariables().map((v) => `no mutable module state\n    ${v}`)];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const violations = collectSourcePolicyViolations();
  if (violations.length > 0) {
    console.error("Source policy check failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(`Source policy check: OK (${policies.length + 1} policies)`);
  }
}
