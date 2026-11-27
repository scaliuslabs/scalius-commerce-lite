// A released bundle's functions, run as a store runs them (tests/replay/bundles.test.ts): the
// buyer's real cart check and checkout quote (`POST /orders/cart-validation`, `POST
// /orders/tax-quote`, the routes themselves) on a seeded store with the release installed and
// approved. Every function and buyer UI extension those requests reach runs through the host the
// routes build (`createCheckoutAppFunctions`, `runPluginFunctions`, `PluginHost`, the
// `SandboxLoader`): the cart the apps read is core's own (`buildAppFunctionCart` from the seeded
// rows), offers are priced by the offers run, and each answer is judged by the host's validator.
// Below the sandbox boundary a Worker Loader stand-in runs the platform's generated isolate
// wrapper (`SANDBOX_RUNTIME_MODULE`) with the release's own bundle in a worker thread, behind a
// structured clone each way, with no network (global fetch refuses), terminated at a deadline.
//
// The clock is fixed (`REPLAY_NOW`; every deadline the host computes from it stands still) and the
// host's wall timers do not fire: a loaded machine cannot turn a recorded answer into a timeout.
// The isolate's own deadline (`ISOLATE_DEADLINE_MS`, real time) stands in for the wall: past it the
// run is recorded "timed out" and the worker is terminated, so a busy loop cannot hang the gate.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { OpenAPIHono } from "@hono/zod-openapi";
import { vi } from "vitest";
import { getDb } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { activatePlugin, PluginError, writePluginSettings, type PluginInstallation } from "@scalius/core/modules/plugins";
import { COOKIE_NAME, hashCustomerSessionToken } from "@scalius/core/modules/customers";
import { putObjectRecord } from "@scalius/core/modules/objects";
import { productSemanticSectionPatchSchema, updateProductSemanticSection } from "@scalius/core/modules/product-admin";
import { PLUGIN_EXTENSION_RUN, type PluginRunPoint } from "@scalius/shared/plugins";
import type { PluginSettingValue } from "@scalius/shared/plugins/settings-schema";
import type { PluginInvocationResult } from "@scalius/plugin-sdk/runtime";
import { setPluginCustomFieldValues } from "../custom-fields";
import { PluginHost, pluginBridgeAuthority, type PluginInvocationOutcome } from "../host";
import { pluginBundleKey } from "../loaders/sandbox";
import type { PluginRelease } from "../releases";
import { installRelease } from "../releases";
import { orderRoutes } from "../../routes/storefront-orders/index";
import { errorResponseFromError } from "../../utils/api-response";
import { PLUGIN_TEST_CREDENTIAL_KEY, pluginTestCtx, pluginTestEnv, settleBackground } from "./fixtures";
import type { ReplayVerdict } from "./replay";

/**
 * A frozen bundle's replay settings (an optional file its `replay.json` entry names, frozen with
 * it): what a merchant set up so the bundle's functions take their real paths instead of answering
 * "nothing to do". Every key is the app's own (no `<app id>.` prefix) and must be one the release
 * declares: a key it does not declare is an error, never skipped (a typo would test nothing).
 */
export interface ReplaySettings {
  /** The app's features that are on; default every declared one. */
  features?: string[];
  /** The merchant's settings, saved as the settings form saves them. */
  settings?: Record<string, PluginSettingValue>;
  /** The merchant's translatable settings in other languages (`<language>` → `<key>` → text). */
  settingTranslations?: Record<string, Record<string, string>>;
  /** Buyer answers to the app's checkout attributes, on every request. */
  attributes?: Record<string, string>;
  /** Records of the app's own storage objects (`<object>` → `<record id>` → record), as the app would have written them. */
  objects?: Record<string, Record<string, Record<string, unknown>>>;
  /**
   * The eligible item, one the app's own features act on: its product's and SKU's values of the
   * app's custom fields, the line's answers to the app's line inputs and the app's purchase options
   * it names. Without it the fixtures have no eligible line.
   */
  eligible?: {
    product?: Record<string, unknown>;
    variant?: Record<string, unknown>;
    properties?: Record<string, string>;
    purchaseOptions?: string[];
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringsOf = (value: unknown) => isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");

/** Reads a replay settings file's JSON; throws on a key or type the replay does not know. */
export function parseReplaySettings(value: unknown): ReplaySettings {
  const fail = (message: string): never => { throw new Error(`Replay settings: ${message}`); };
  if (!isRecord(value)) fail("a JSON object.");
  const known = ["$comment", "features", "settings", "settingTranslations", "attributes", "objects", "eligible"];
  const unknown = Object.keys(value as object).find((key) => !known.includes(key));
  if (unknown) fail(`no "${unknown}" (known: ${known.join(", ")}).`);
  const settings = value as Record<string, unknown>;
  if (settings.features !== undefined && !(Array.isArray(settings.features) && settings.features.every((entry) => typeof entry === "string"))) fail("features is a list of feature ids.");
  if (settings.settings !== undefined && !isRecord(settings.settings)) fail("settings is an object of setting values.");
  if (settings.settingTranslations !== undefined && !(isRecord(settings.settingTranslations) && Object.values(settings.settingTranslations).every(stringsOf))) fail("settingTranslations is <language> → <key> → text.");
  if (settings.attributes !== undefined && !stringsOf(settings.attributes)) fail("attributes is <key> → text.");
  if (settings.objects !== undefined && !(isRecord(settings.objects) && Object.values(settings.objects).every((records) => isRecord(records) && Object.values(records).every(isRecord)))) fail("objects is <object> → <record id> → record.");
  if (settings.eligible !== undefined) {
    if (!isRecord(settings.eligible)) fail("eligible is an object.");
    const eligible = settings.eligible as Record<string, unknown>;
    const extra = Object.keys(eligible).find((key) => !["product", "variant", "properties", "purchaseOptions"].includes(key));
    if (extra) fail(`eligible has no "${extra}" (known: product, variant, properties, purchaseOptions).`);
    if (eligible.product !== undefined && !isRecord(eligible.product)) fail("eligible.product is <custom field key> → value.");
    if (eligible.variant !== undefined && !isRecord(eligible.variant)) fail("eligible.variant is <custom field key> → value.");
    if (eligible.properties !== undefined && !stringsOf(eligible.properties)) fail("eligible.properties is <line input key> → answer.");
    if (eligible.purchaseOptions !== undefined && !(Array.isArray(eligible.purchaseOptions) && eligible.purchaseOptions.every((entry) => typeof entry === "string"))) fail("eligible.purchaseOptions is a list of purchase option keys.");
  }
  return settings as ReplaySettings;
}

/** Every key the settings name that `manifest` does not declare (with the features on): each is an author's error. */
function undeclaredSettings(installation: PluginInstallation, settings: ReplaySettings): string[] {
  const manifest = installation.manifest;
  const declaredFeatures = new Set(installation.declaredManifest.features.map((feature) => feature.id));
  const keys = new Set(manifest.settings.map((field) => field.key));
  const translatable = new Set(manifest.settings.filter((field) => "translatable" in field && field.translatable).map((field) => field.key));
  const fields = (ownerType: string) => new Set(manifest.customFields.filter((field) => field.ownerType === ownerType).map((field) => field.key));
  const inputs = new Set((manifest.checkout?.lineInputs ?? []).map((input) => input.key));
  const options = new Set((manifest.checkout?.purchaseOptions ?? []).map((option) => option.key));
  const attributes = new Set((manifest.checkout?.attributes ?? []).map((field) => field.key));
  return [
    ...(settings.features ?? []).filter((id) => !declaredFeatures.has(id)).map((id) => `feature ${id}`),
    ...Object.keys(settings.settings ?? {}).filter((key) => !keys.has(key)).map((key) => `setting ${key}`),
    ...Object.entries(settings.settingTranslations ?? {}).flatMap(([language, values]) => Object.keys(values).filter((key) => !translatable.has(key)).map((key) => `translatable setting ${key} (${language})`)),
    ...Object.keys(settings.attributes ?? {}).filter((key) => !attributes.has(key)).map((key) => `checkout attribute ${key}`),
    ...Object.keys(settings.objects ?? {}).filter((name) => !manifest.objects[name]).map((name) => `storage object ${name}`),
    ...(["product", "variant"] as const).flatMap((owner) => Object.keys(settings.eligible?.[owner] ?? {}).filter((key) => !fields(owner).has(key)).map((key) => `${owner} custom field ${key}`)),
    ...Object.keys(settings.eligible?.properties ?? {}).filter((key) => !inputs.has(key)).map((key) => `line input ${key}`),
    ...(settings.eligible?.purchaseOptions ?? []).filter((key) => !options.has(key)).map((key) => `purchase option ${key}`),
  ];
}

/** The instant the replay's store lives at: every function run hears it (`input.now`), and it never moves. */
export const REPLAY_NOW = Date.UTC(2027, 0, 15, 9, 30);
/** Real time an isolate run may take before it is recorded "timed out" and its worker terminated. */
export const ISOLATE_DEADLINE_MS = 10_000;

/** What crossed the sandbox boundary on one run, for its digests (tests/replay/replay-compat.ts). */
export interface ReplayRunTrace {
  /** `{ point, input, seed }` as the isolate received them. */
  call: unknown;
  /** The bundle's own answer (before the host's validator), or null when it gave none. */
  answer: unknown;
}

export interface ReplayFunctions {
  /** The host's load check: the module loads and declares every handler its manifest does (or why it cannot run). */
  load: ReplayVerdict;
  /** `<route> · <scenario>` → what the buyer's request answered. */
  requests: Record<string, ReplayVerdict>;
  /** `<route> · <scenario> · <point>[ <slot>][ (offers)]` → what the host made of the run. */
  runs: Record<string, ReplayVerdict>;
  traces: Record<string, ReplayRunTrace>;
}

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
/** Where a release's isolate modules are written for the worker to import (under node_modules: loaded as is). */
const ISOLATES = join(ROOT, "node_modules/.cache/scalius-replay");
const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
// The real timers, taken before any replay fakes them: the isolate's deadline is real time.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** The isolate: a worker thread that imports the generated wrapper (with the bundle beside it) and answers its entrypoint's calls. */
const ISOLATE_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");
globalThis.fetch = async () => { throw new Error("This isolate is not permitted to access the internet (globalOutbound: null)."); };
let sandbox = null;
parentPort.on("message", async ({ id, method, args }) => {
  try {
    sandbox ??= import(pathToFileURL(workerData.wrapper).href).then((module) => new module.default({}, {}));
    parentPort.postMessage({ id, ok: true, value: await (await sandbox)[method](...args) });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: { name: error && error.name || "Error", message: String(error && error.message || error) } });
  }
});`;

export class IsolateTimeout extends Error {
  constructor(deadlineMs = ISOLATE_DEADLINE_MS) {
    super(`The run did not answer within ${deadlineMs} ms.`);
    this.name = "IsolateTimeout";
  }
}

/** One release's isolate: calls cross a structured clone (postMessage) each way, as Workers RPC does. */
export class Isolate {
  private worker: Worker | null = null;
  private serial = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  constructor(private readonly wrapper: string, private readonly deadlineMs = ISOLATE_DEADLINE_MS) {}

  private start(): Worker {
    const worker = new Worker(ISOLATE_SOURCE, { eval: true, workerData: { wrapper: this.wrapper } });
    worker.on("message", ({ id, ok, value, error }: { id: number; ok: boolean; value: unknown; error?: { name: string; message: string } }) => {
      const waiting = this.pending.get(id);
      this.pending.delete(id);
      if (!waiting) return;
      if (ok) waiting.resolve(value);
      else waiting.reject(Object.assign(new Error(error?.message ?? "failed"), { name: error?.name ?? "Error" }));
    });
    worker.on("error", (error) => this.fail(error));
    return worker;
  }

  private fail(error: Error): void {
    for (const waiting of this.pending.values()) waiting.reject(error);
    this.pending.clear();
    void this.worker?.terminate();
    this.worker = null;
  }

  call(method: string, args: unknown[]): Promise<unknown> {
    this.worker ??= this.start();
    const id = (this.serial += 1);
    return new Promise((resolve, reject) => {
      const timer = realSetTimeout(() => this.fail(new IsolateTimeout(this.deadlineMs)), this.deadlineMs);
      this.pending.set(id, {
        resolve: (value) => { realClearTimeout(timer); resolve(value); },
        reject: (error) => { realClearTimeout(timer); reject(error); },
      });
      this.worker!.postMessage({ id, method, args });
    });
  }

  async close(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
  }
}

/** One run as the replay watched it at the host's edge and at the sandbox boundary. */
interface RunRecord {
  point: PluginRunPoint;
  target: string | null;
  offers: boolean;
  call: unknown;
  raw: PluginInvocationResult | null;
  timedOut: boolean;
  outcome: PluginInvocationOutcome<unknown> | null;
  notices: string[];
}
interface RequestLog {
  records: RunRecord[];
  incidents: Array<{ source: string; message: string }>;
}

/** The seeded store's catalogue: plain items, a kit of two of them, and the eligible item. */
const PRODUCTS = [
  { product: "p_tee", variant: "v_tee", sku: "TEE-M", name: "T-shirt", priceMinor: 50_000 },
  { product: "p_mug", variant: "v_mug", sku: "MUG-1", name: "Mug", priceMinor: 30_000 },
  { product: "p_kit", variant: "v_kit", sku: "KIT-1", name: "Starter kit", priceMinor: 70_000 },
  { product: "p_eligible", variant: "v_eligible", sku: "ELIGIBLE-1", name: "Eligible item", priceMinor: 222_200 },
] as const;
const SESSION_TOKEN = "replay-buyer-session-token";
const SESSION_KEY = "replay-buyer-session-key-0123456789abcdef";

/** One buyer's cart, as the storefront sends it to the cart check (and, with `quote`, to the checkout quote). */
interface Scenario {
  label: string;
  language: "en" | "bn";
  /** The page's market presence: `bn-bd` Bangla, `en-us` the dollar market. */
  presence?: string;
  signedIn: boolean;
  items: Array<{ cartKey: string; productId: string; variantId: string; quantity: number; properties?: Array<{ key: string; value: string }>; purchaseOptions?: string[] }>;
  discountCodes?: string[];
  /** Also the checkout quote (Dhaka, standard delivery; it prices by where it ships, so in taka, in the page's language): the dollar market's cart has no delivery to quote. */
  quote: boolean;
}

/** The fixture requests: plain lines, a kit, a signed-in buyer with a discount code, Bangla, dollars, and the eligible item decided and undecided. */
function scenarios(appId: string, settings: ReplaySettings | null): Scenario[] {
  const line = (key: string, product: string, variant: string, quantity: number, extra: Partial<Scenario["items"][number]> = {}) => ({ cartKey: `line:${key}`, productId: product, variantId: variant, quantity, ...extra });
  const plain = [line("tee", "p_tee", "v_tee", 2), line("mug", "p_mug", "v_mug", 1)];
  const answers = Object.entries(settings?.eligible?.properties ?? {}).map(([key, value]) => ({ key: `${appId}.${key}`, value }));
  const options = (settings?.eligible?.purchaseOptions ?? []).map((key) => `${appId}.${key}`);
  const eligible = (decided: boolean) => [
    line("eligible", "p_eligible", "v_eligible", 2, { ...(decided && answers.length ? { properties: answers } : {}), ...(options.length ? { purchaseOptions: options } : {}) }),
    line("tee", "p_tee", "v_tee", 1),
  ];
  const list: Scenario[] = [
    { label: "plain lines, guest, en", language: "en", signedIn: false, items: plain, quote: true },
    { label: "a kit, signed in, code, en", language: "en", signedIn: true, items: [line("kit", "p_kit", "v_kit", 1), line("tee", "p_tee", "v_tee", 1)], discountCodes: ["REPLAY10"], quote: true },
  ];
  if (!settings?.eligible) {
    list.push(
      { label: "plain lines, guest, bn", language: "bn", presence: "bn-bd", signedIn: false, items: plain, quote: true },
      { label: "plain lines, guest, USD", language: "en", presence: "en-us", signedIn: false, items: plain, quote: false },
    );
    return list;
  }
  list.push(
    { label: "eligible line, guest, en", language: "en", signedIn: false, items: eligible(true), quote: true },
    { label: "eligible line, signed in, bn", language: "bn", presence: "bn-bd", signedIn: true, items: eligible(true), quote: true },
    { label: "eligible line, guest, USD", language: "en", presence: "en-us", signedIn: false, items: eligible(true), quote: false },
    { label: "eligible line undecided, guest, en", language: "en", signedIn: false, items: eligible(false), quote: true },
  );
  return list;
}

/** A run's answer in words: the fields it filled (`addOns: 2`, `ui`), or that it is empty. */
function answered(value: unknown): string {
  if (!isRecord(value)) return `ran (${JSON.stringify(value)})`;
  const filled = Object.entries(value).flatMap(([key, field]) => {
    if (Array.isArray(field)) return field.length > 0 ? [`${key}: ${field.length}`] : [];
    return field === null || field === undefined || field === false ? [] : [key];
  });
  return filled.length > 0 ? `ran (${filled.join(", ")})` : "ran (empty answer)";
}

function verdictOf(record: RunRecord): ReplayVerdict {
  const outcome = record.outcome;
  if (record.timedOut) return [`timed out: ${new IsolateTimeout().message}`];
  if (!outcome) return ["not called"];
  if (outcome.ok) return record.notices.length > 0 ? [answered(record.raw?.value ?? outcome.value), ...record.notices.map((message) => `the store's word: ${message}`)] : answered(record.raw?.value ?? outcome.value);
  const kind = outcome.failure === "invalid" ? "refused" : outcome.failure === "timeout" ? "timed out" : outcome.failure === "error" ? "threw" : outcome.failure;
  return [`${kind}: ${outcome.error}`];
}

/** What the buyer's request answered: valid or not, its app rule errors and buyer UI blocks; or its refusal. */
function requestVerdict(status: number, body: unknown): ReplayVerdict {
  const json = isRecord(body) ? body : {};
  if (status !== 200 || json.success !== true) {
    const error = isRecord(json.error) ? json.error : {};
    return [`refused ${status}: ${String(error.code ?? "error")}: ${String(error.message ?? "")}`];
  }
  const data = isRecord(json.data) ? json.data : {};
  const parts = [typeof data.valid === "boolean" ? (data.valid ? "valid" : "not valid") : "quoted"];
  if (Array.isArray(data.ruleErrors) && data.ruleErrors.length > 0) parts.push(`rule errors: ${data.ruleErrors.length}`);
  if (Array.isArray(data.buyerUi) && data.buyerUi.length > 0) parts.push(`buyer UI blocks: ${data.buyerUi.length}`);
  return `answered (${parts.join(", ")})`;
}

/** Seeds the store the requests run against (the release's install and approval come after). */
async function seedStore(sqlite: ReturnType<typeof createSqliteD1Database>["sqlite"], db: ReturnType<typeof createSqliteD1Database>["db"]): Promise<void> {
  sqlite.exec(`
    INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1);
    INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
      VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'Gulshan', 'BD', 2, 'city_1', '{}', '{}', 1);
    INSERT INTO delivery_zones (id, name) VALUES ('dz_bd', 'Bangladesh');
    INSERT INTO delivery_zone_regions (country_code, zone_id) VALUES ('BD', 'dz_bd');
    INSERT INTO shipping_methods (id, name, fee_minor, kind, sort_order, zone_id) VALUES ('m_std', 'Standard', 6000, 'delivery', 0, 'dz_bd');
    INSERT INTO store_languages (locale, published) VALUES ('bn', 1);
    INSERT INTO markets (id, handle, name, status) VALUES ('mkt_bn', 'bangla', 'Bangla', 'active');
    INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_bn', 'mkt_bn', 'subfolder', 'bn-bd', 'bn');
    INSERT INTO markets (id, handle, name, status, price_mode, fx_rate, currency_code, fx_rate_as_of)
      VALUES ('mkt_us', 'united-states', 'United States', 'active', 'fx', '0.0083', 'USD', ${Math.floor(REPLAY_NOW / 1000) - 3_600});
    INSERT INTO market_countries (country_code, market_id) VALUES ('US', 'mkt_us');
    INSERT INTO market_presences (id, market_id, kind, value, locale) VALUES ('mkp_us', 'mkt_us', 'subfolder', 'en-us', 'en');
    INSERT INTO customers (id, name, phone, account_claimed_at) VALUES ('cust_1', 'Replay Buyer', '+8801711111111', ${Math.floor(REPLAY_NOW / 1000)});
  `);
  for (const item of PRODUCTS) {
    sqlite.prepare("INSERT INTO products (id, name, slug, price_minor, is_active, is_gift_card) VALUES (?, ?, ?, ?, 1, 0)").run(item.product, item.name, item.product.replace("_", "-"), item.priceMinor);
    // The Bangla page reads the item in Bangla.
    sqlite.prepare("INSERT INTO translations (id, resource_type, resource_id, locale, fields, source_digest) VALUES (?, 'product', ?, 'bn', ?, '{}')").run(`tr_${item.product}`, item.product, JSON.stringify({ name: `${item.name} (বাংলা)` }));
    sqlite.prepare(`INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
      VALUES (?, ?, ?, ?, ?, 0, 0, 1, 1, 'physical')`).run(item.variant, item.product, item.sku, item.priceMinor, item.variant === "v_kit" ? 0 : 100);
  }
  sqlite.prepare("INSERT INTO customer_sessions (token_hash, customer_id, expires_at) VALUES (?, 'cust_1', ?)")
    .run(await hashCustomerSessionToken(SESSION_TOKEN, SESSION_KEY), Math.floor(REPLAY_NOW / 1000) + 3_600);
  // The kit: one T-shirt and one mug, sold as one line at its own price (the product editor's Kits section).
  const revision = (sqlite.prepare("SELECT aggregate_revision AS r FROM products WHERE id = 'p_kit'").get() as { r: number }).r;
  await updateProductSemanticSection(db, "p_kit", productSemanticSectionPatchSchema.parse({
    section: "kits", expectedAggregateRevision: revision, variantId: "v_kit", components: [{ variantId: "v_tee", quantity: 1 }, { variantId: "v_mug", quantity: 1 }],
  }) as never);
}

/**
 * Every function and buyer UI extension the release reaches on the fixture requests, run as a
 * store runs them (see the file comment). Returns the load check, each request's answer and each
 * run's verdict and trace.
 */
export async function replayFunctions(release: PluginRelease, settings: ReplaySettings | null): Promise<ReplayFunctions> {
  const { sqlite, db, binding } = createSqliteD1Database();
  const realFetch = globalThis.fetch;
  const hostMethods = { invokeFunction: PluginHost.prototype.invokeFunction, incident: PluginHost.prototype.incident, notice: PluginHost.prototype.notice };
  const isolates: { current: Promise<Isolate> | null } = { current: null };
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: REPLAY_NOW });
  try {
    await seedStore(sqlite, db);
    let installation = await installRelease(db, release, { source: "upload", actorUserId: "owner" });
    const appId = installation.pluginId;
    // Approved first (a feature's settings exist only while it is on), then the merchant's settings saved.
    try {
      installation = await activatePlugin(db, appId, {
        actorUserId: "owner", expectedRevision: installation.revision,
        features: settings?.features ?? installation.declaredManifest.features.map((feature) => feature.id),
      });
    } catch (error) {
      return { load: [`approval refused: ${error instanceof Error ? error.message : String(error)}`], requests: {}, runs: {}, traces: {} };
    }
    if (settings) {
      const undeclared = undeclaredSettings(installation, settings);
      if (undeclared.length > 0) throw new Error(`${appId}@${installation.version}'s replay settings name what this release does not declare: ${undeclared.join(", ")}. Give this release its own settings file.`);
    }
    if (settings?.settings || settings?.settingTranslations) {
      try {
        installation = await writePluginSettings(db, appId, settings.settings ?? {}, {
          expectedRevision: installation.revision, credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY,
          ...(settings.settingTranslations ? { translations: settings.settingTranslations } : {}),
        });
      } catch (error) {
        if (!(error instanceof PluginError)) throw error;
        return { load: [`settings refused: ${error.pluginCode}: ${error.message}`], requests: {}, runs: {}, traces: {} };
      }
    }
    for (const [name, records] of Object.entries(settings?.objects ?? {})) {
      for (const [id, record] of Object.entries(records)) await putObjectRecord(db, appId, name, installation.manifest.objects[name]!, id, record);
    }
    const fields = pluginBridgeAuthority(installation).customFields;
    for (const [ownerType, ownerId] of [["product", "p_eligible"], ["variant", "v_eligible"]] as const) {
      const values = settings?.eligible?.[ownerType];
      if (values && Object.keys(values).length > 0) await setPluginCustomFieldValues(db, appId, fields, ownerType, ownerId, values);
    }

    // Below the sandbox boundary: the bucket holds the release's bundle; the loader's isolate runs the generated wrapper with it.
    const bundle = release.code;
    if (sha256(bundle) !== installation.bundleSha256) throw new Error(`${appId}: the installed bundle hash is not its code's.`);
    const invocation = new AsyncLocalStorage<RunRecord>();
    const loader = {
      get(_id: string, code: () => Promise<{ modules: Record<string, string>; env: unknown; globalOutbound: unknown }>) {
        isolates.current ??= code().then((spec) => {
          if (spec.globalOutbound !== null || JSON.stringify(spec.env) !== "{}") throw new Error("The sandbox must cut the network and hand no bindings.");
          const dir = join(ISOLATES, installation.bundleSha256);
          mkdirSync(dir, { recursive: true });
          const wrapper = spec.modules["wrapper.js"]!.replace(/from\s*"cloudflare:workers"/, 'from"./cloudflare-workers.js"');
          const wrapperPath = join(dir, `wrapper-${sha256(wrapper).slice(0, 16)}.js`);
          writeFileSync(join(dir, "plugin.js"), spec.modules["plugin.js"]!);
          writeFileSync(join(dir, "cloudflare-workers.js"), "export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\n");
          writeFileSync(wrapperPath, wrapper);
          return new Isolate(wrapperPath);
        });
        const run = async (method: string, args: unknown[]) => {
          const record = invocation.getStore();
          if (record && method === "invokeFunction") record.call = structuredClone({ point: args[1], input: args[2], seed: args[0] });
          try {
            const result = await (await isolates.current!).call(method, args) as PluginInvocationResult;
            if (record) record.raw = result;
            return result;
          } catch (error) {
            if (record && error instanceof IsolateTimeout) record.timedOut = true;
            throw error;
          }
        };
        return {
          getEntrypoint: () => ({
            invokeFunction: (seed: unknown, point: string, input: unknown) => run("invokeFunction", [seed, point, input]),
            invokeCheck: (seed: unknown) => run("invokeCheck", [seed]),
          }),
        };
      },
    };
    const bucket = {
      get: async (key: string) => key === pluginBundleKey(appId, installation.version, installation.bundleSha256) ? { arrayBuffer: async () => bundle.slice().buffer } : null,
    };
    const env = pluginTestEnv(binding, {
      LOADER: loader, BUCKET: bucket, CUSTOMER_SESSION_HASH_KEY: SESSION_KEY,
      SCALIUS_SECRET: "replay-master-secret-0123456789abcdefghijklmnopqrstuv",
    });
    const ctx = { ...pluginTestCtx(), exports: { PluginBridge: () => ({}) } } as unknown as ExecutionContext;
    globalThis.fetch = (async () => { throw new Error("The replay's store is not permitted to access the internet."); }) as typeof fetch;

    const load = await new PluginHost({ env, ctx, db }).checkLoads(installation);
    const result: ReplayFunctions = { load: load.ok ? "loads" : [`${load.failure}: ${load.error}`], requests: {}, runs: {}, traces: {} };
    if (!load.ok) return result;

    // The host the routes build, watched at its edge: each run's outcome, incidents and word notices.
    const request = new AsyncLocalStorage<RequestLog>();
    PluginHost.prototype.invokeFunction = async function (this: PluginHost, ...args: Parameters<PluginHost["invokeFunction"]>) {
      const [, point, input] = args;
      const given = isRecord(input) ? input : {};
      const record: RunRecord = { point, target: typeof given.target === "string" ? given.target : null, offers: Array.isArray(given.offers), call: null, raw: null, timedOut: false, outcome: null, notices: [] };
      request.getStore()?.records.push(record);
      record.outcome = await invocation.run(record, () => hostMethods.invokeFunction.apply(this, args)) as PluginInvocationOutcome<unknown>;
      return record.outcome as never;
    } as PluginHost["invokeFunction"];
    PluginHost.prototype.incident = async function (this: PluginHost, ...args: Parameters<PluginHost["incident"]>) {
      if (!invocation.getStore()) request.getStore()?.incidents.push({ source: args[1], message: args[2] });
      return hostMethods.incident.apply(this, args);
    };
    PluginHost.prototype.notice = function (this: PluginHost, ...args: Parameters<PluginHost["notice"]>) {
      invocation.getStore()?.notices.push(...args[2]);
      return hostMethods.notice.apply(this, args);
    };

    const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api/v1");
    app.onError((error, c) => {
      const { body, status } = errorResponseFromError(error);
      return c.json(body, status);
    });
    app.use("*", async (c, next) => { c.set("db", getDb(env)); await next(); });
    app.route("/orders", orderRoutes);
    const attributes = Object.fromEntries(Object.entries(settings?.attributes ?? {}).map(([key, value]) => [`${appId}.${key}`, value]));
    const buyerAnswers = Object.keys(attributes).length > 0 ? { attributes } : {};
    for (const scenario of scenarios(appId, settings)) {
      const routes: Array<[string, Record<string, unknown>]> = [
        ["cart-validation", { items: scenario.items, ...buyerAnswers, ...(scenario.presence ? { presence: scenario.presence } : {}), ...(scenario.presence === "en-us" ? {} : { shippingCountryCode: "BD" }), ...(scenario.discountCodes ? { discountCodes: scenario.discountCodes } : {}) }],
        ...(scenario.quote ? [["tax-quote", { items: scenario.items, ...buyerAnswers, city: "city_1", zone: "zone_1", shippingMethodId: "m_std", discountCodes: scenario.discountCodes ?? [] }] as [string, Record<string, unknown>]] : []),
      ];
      for (const [route, body] of routes) {
        const log: RequestLog = { records: [], incidents: [] };
        const response = await request.run(log, () => app.request(`/api/v1/orders/${route}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-storefront-language": scenario.language,
            "x-storefront-locale": `${scenario.language}-BD`,
            ...(scenario.signedIn ? { Cookie: `${COOKIE_NAME}=${SESSION_TOKEN}` } : {}),
          },
          body: JSON.stringify(body),
        }, env, ctx as never));
        const prefix = `${route} · ${scenario.label}`;
        result.requests[prefix] = requestVerdict(response.status, await response.json().catch(() => null));
        const seen = new Map<string, number>();
        const unique = (label: string) => {
          const count = (seen.get(label) ?? 0) + 1;
          seen.set(label, count);
          return count === 1 ? label : `${label} #${count}`;
        };
        for (const record of log.records) {
          const label = unique(`${prefix} · ${record.point}${record.target ? ` ${record.target}` : ""}${record.offers ? " (offers)" : ""}`);
          result.runs[label] = verdictOf(record);
          if (record.call) result.traces[label] = { call: record.call, answer: record.raw?.ok ? record.raw.value ?? null : null };
        }
        // A function the host left out before calling it (a declared read that failed): its incident says why.
        for (const { source, message } of log.incidents) {
          if (!message.includes("did not run")) continue;
          result.runs[unique(`${prefix} · ${source.replace(/^function:|^extension:/, (kind) => (kind === "extension:" ? `${PLUGIN_EXTENSION_RUN} ` : ""))}`)] = [`not run: ${message}`];
        }
      }
    }
    return result;
  } finally {
    Object.assign(PluginHost.prototype, hostMethods);
    try {
      await settleBackground();
    } finally {
      await (await isolates.current?.catch(() => null))?.close();
      globalThis.fetch = realFetch;
      vi.useRealTimers();
      sqlite.close();
    }
  }
}
