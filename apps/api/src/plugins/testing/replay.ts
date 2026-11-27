// A released app or theme bundle (its upload ZIP) through what this build of
// the store runs on it, each step the code a store runs, recorded as plain
// words so tests/replay/bundles.test.ts can hold every release to what it did
// before:
//
// - install: the upload's checks (`readPluginPackageZip`,
//   `verifyUploadedPackage` as a Super Admin accepting an unsigned package or
//   a new developer) and the install itself, on a fresh migrated database;
// - theme: each template upgraded from its `themeVersion` and checked
//   (`checkStorefrontAppTemplateTheme`), applied to the default look and
//   saved (`checkStorefrontThemeSave`), and each page preset upgraded;
// - functions: every checkout function and buyer UI extension the bundle
//   declares, run through the host exactly as checkout and the buyer's pages
//   run them (`runPluginFunctions`: registrations, declared reads from the
//   database, per-app scoping, `PluginHost`, the `SandboxLoader`), up to the
//   sandbox boundary, over fixture carts built from the SDK's fixtures; each
//   answer judged by the host's own validator (`checkPluginFunctionOutput`)
//   and its word notices; plus the host's load check (every handler the
//   manifest declares is there);
// - render jobs: each skin and component section with the values the
//   applied template gives it, over the SDK's sample fixture store. The test
//   draws them with the storefront's own render host (it joins two apps, so
//   that half lives in the test).

import { createHash } from "node:crypto";
import { vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  activatePlugin,
  activePluginStorefrontExtensions,
  listActiveFunctionPlugins,
  PluginError,
  writePluginSettings,
  type PluginInstallation,
} from "@scalius/core/modules/plugins";
import { pluginGrantRequest, PLUGIN_EXTENSION_RUN, type FunctionCart, type PluginManifest, type PluginRunPoint } from "@scalius/shared/plugins";
import { parsePluginSurfaceKey } from "@scalius/shared/plugins/storefront";
import { resolveStorefrontSettings, type StorefrontExtension, type StorefrontRenderContext, type StorefrontRenderJob } from "@scalius/shared/plugins/storefront-components";
import { STOREFRONT_UI_SLOT_PAGES, type StorefrontSkinTarget, type StorefrontUiSlot } from "@scalius/shared/plugins/storefront-protocol";
import type { PluginSettingsSchema, PluginSettingValue } from "@scalius/shared/plugins/settings-schema";
import { invokePluginDefinition, type PluginContextSeed, type PluginInvocationResult } from "@scalius/plugin-sdk/runtime";
import {
  applyStorefrontAppTemplate,
  checkStorefrontAppTemplateTheme,
  checkStorefrontPagePresetSections,
  DEFAULT_STOREFRONT_THEME,
  type StorefrontThemeDocument,
} from "@scalius/shared/storefront-theme";
import { checkStorefrontThemeSave, type StorefrontThemeSaveIssue } from "@scalius/shared/storefront-theme/save";
import { fixtures } from "@scalius/plugin-sdk/testing";
import { fixtureStore } from "@scalius/plugin-sdk/storefront/testing";
import { setPluginCustomFieldValues } from "../custom-fields";
import { PluginFunctionsBlockedError, runPluginFunctions } from "../functions";
import { PluginHost, pluginBridgeAuthority } from "../host";
import { pluginBundleKey } from "../loaders/sandbox";
import { readPluginPackageZip } from "../package-zip";
import { installRelease, verifyUploadedPackage, type PluginRelease } from "../releases";
import { PLUGIN_TEST_CREDENTIAL_KEY, pluginTestCtx, pluginTestEnv, settleBackground } from "./fixtures";

/** One step's outcome: `accepted`-style words, or the refusal's lines. */
export type ReplayVerdict = string | string[];

function refusalOf(error: unknown): string[] {
  if (error instanceof PluginError) {
    const details = (error.details ?? {}) as { reason?: unknown; issues?: Array<{ path?: unknown; message?: unknown }> };
    const lines = [`${error.pluginCode}${typeof details.reason === "string" ? ` (${details.reason})` : ""}: ${error.message}`];
    for (const issue of details.issues ?? []) lines.push(`  ${String(issue.path ?? "")}: ${String(issue.message ?? "")}`);
    return lines;
  }
  return [`threw: ${error instanceof Error ? error.message : String(error)}`];
}

function issueLines(issues: readonly StorefrontThemeSaveIssue[]): string[] {
  return issues.map((issue) => `${issue.path || "(root)"}: ${issue.message}${issue.reason ? ` (${issue.reason})` : ""}`);
}

export interface ReplayInstall {
  verdict: ReplayVerdict;
  release: PluginRelease | null;
  installation: PluginInstallation | null;
}

/** The upload's checks and the install, as a store runs them on this ZIP. */
export async function replayInstall(zip: Uint8Array): Promise<ReplayInstall> {
  const { sqlite, db } = createSqliteD1Database();
  try {
    const files = await readPluginPackageZip(zip);
    const { release } = await verifyUploadedPackage(db, files, { allowUnsigned: true, trustDeveloper: true });
    const installation = await installRelease(db, release, { source: "upload", actorUserId: null });
    return { verdict: release.signer ? "accepted (signed)" : "accepted (unsigned)", release, installation };
  } catch (error) {
    return { verdict: refusalOf(error), release: null, installation: null };
  } finally {
    sqlite.close();
  }
}

export interface ReplayTheme {
  templates: Record<string, ReplayVerdict>;
  pagePresets: Record<string, ReplayVerdict>;
  /** The default look with the first template that saved applied (the values the render jobs take), else the default look. */
  applied: StorefrontThemeDocument;
}

/** Each template upgraded, applied to the default look and saved; each page preset upgraded. */
export function replayTheme(manifest: PluginManifest): ReplayTheme {
  const templates: Record<string, ReplayVerdict> = {};
  let applied: StorefrontThemeDocument | null = null;
  for (const template of manifest.storefront.templates) {
    const read = checkStorefrontAppTemplateTheme(template.theme, template.themeVersion, manifest.id, template.id);
    if (!read.ok) {
      templates[template.id] = [`does not fit: ${read.problem}`, ...issueLines(read.issues)];
      continue;
    }
    const document = applyStorefrontAppTemplate(DEFAULT_STOREFRONT_THEME, `${manifest.id}/${template.id}`, read.value);
    const saved = checkStorefrontThemeSave(document);
    if (!saved.ok) {
      templates[template.id] = [`save refused: ${saved.refusal.message}`, ...issueLines(saved.refusal.issues)];
      continue;
    }
    templates[template.id] = "applied and saved";
    applied ??= saved.theme;
  }
  const pagePresets: Record<string, ReplayVerdict> = {};
  for (const preset of manifest.storefront.pagePresets) {
    const read = checkStorefrontPagePresetSections(preset.sections, preset.themeVersion);
    pagePresets[preset.id] = read.ok ? `fits (${read.value.length} sections)` : [`does not fit: ${read.problem}`, ...issueLines(read.issues)];
  }
  return { templates, pagePresets, applied: applied ?? DEFAULT_STOREFRONT_THEME };
}

/**
 * A frozen bundle's replay settings (an optional file its `replay.json` entry
 * names, frozen with it): what a merchant set up so the bundle's functions
 * take their real paths instead of answering "nothing to do". Every field is
 * optional; keys are the app's own (no `<app id>.` prefix).
 */
export interface ReplaySettings {
  /** The app's features that are on; default every declared one. */
  features?: string[];
  /** The merchant's settings, saved as the settings form saves them. */
  settings?: Record<string, PluginSettingValue>;
  /** The merchant's translatable settings in other languages (`<language>` → `<key>` → text). */
  settingTranslations?: Record<string, Record<string, string>>;
  /** Buyer answers to the app's checkout attributes, on every fixture cart. */
  attributes?: Record<string, string>;
  /**
   * The eligible line, a line the app's own features act on: its product's
   * and SKU's values of the app's custom fields, and the line's answers to
   * the app's line inputs. Without it the fixtures have no eligible line.
   */
  eligible?: {
    product?: Record<string, unknown>;
    variant?: Record<string, unknown>;
    properties?: Record<string, string>;
  };
}

const SETTINGS_KEYS = new Set(["$comment", "features", "settings", "settingTranslations", "attributes", "eligible"]);

/** Reads a replay settings file's JSON; throws on a key the replay does not know (a typo would silently test nothing). */
export function parseReplaySettings(value: unknown): ReplaySettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Replay settings are a JSON object.");
  const unknown = Object.keys(value).find((key) => !SETTINGS_KEYS.has(key));
  if (unknown) throw new Error(`Replay settings have no "${unknown}" (known: ${[...SETTINGS_KEYS].join(", ")}).`);
  const eligible = (value as ReplaySettings).eligible;
  const extra = eligible ? Object.keys(eligible).find((key) => !["product", "variant", "properties"].includes(key)) : undefined;
  if (extra) throw new Error(`Replay settings' eligible line has no "${extra}" (known: product, variant, properties).`);
  return value as ReplaySettings;
}

/** The instant every function run hears (`input.now`): fixed, so a frozen bundle's answer digests hold run to run. */
export const REPLAY_NOW = Date.UTC(2027, 0, 15, 9, 30);

/** What a run hands a frozen bundle and what the store kept of its answer, digested (tests/replay/replay-compat.ts `UnitDigest`). */
export interface ReplayRunTrace {
  /** The isolate's call as it crossed the sandbox boundary: `{ point, input, seed }`; null when the app was not called. */
  call: unknown;
  /** The answer the store kept (the validator's value), or the bundle's own answer when the store refused it; null when there was none. */
  answer: unknown;
}

export interface ReplayFunctions {
  /** The host's load check: the module loads and declares every handler its manifest does. */
  load: ReplayVerdict;
  /** `<point> · <fixture>` or `buyer.ui <slot> · <fixture>` → what the host made of the run. */
  runs: Record<string, ReplayVerdict>;
  traces: Record<string, ReplayRunTrace>;
}

const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** One fixture cart: plain lines, a kit, or the eligible line, in a language and currency. */
interface ReplayCart {
  label: string;
  language: "en" | "bn";
  cart: FunctionCart;
  /** Choices to price (`cart.line_prices` offers): the eligible line's answers, asked as a per-line slot asks. */
  offers?: Array<{ offerId: string; lineId: string; key: string; value: string }>;
}

const REPLAY_PRODUCTS = [
  { product: "prod_1", variant: "var_1", sku: "TSHIRT-M", title: "T-shirt", priceMinor: 50_000 },
  { product: "prod_2", variant: "var_2", sku: "MUG-1", title: "Mug", priceMinor: 30_000 },
  { product: "prod_kit", variant: "var_kit", sku: "KIT-1", title: "Starter kit", priceMinor: 300_000 },
  { product: "prod_eligible", variant: "var_eligible", sku: "ELIGIBLE-1", title: "Eligible item", priceMinor: 222_200 },
] as const;
/** The second currency: USD at 120 taka. */
const USD_PER_BDT = 1 / 120;

/** The fixture carts every function is run on (the SDK's `fixtures.cart` and `fixtures.cartLine`). */
function replayCarts(appId: string, settings: ReplaySettings | null): ReplayCart[] {
  const attributes = Object.fromEntries(Object.entries(settings?.attributes ?? {}).map(([key, value]) => [`${appId}.${key}`, value]));
  const line = (index: number, lineId: string, quantity: number, usd: boolean, extra: Partial<FunctionCart["lines"][number]> = {}) => {
    const item = REPLAY_PRODUCTS[index]!;
    const unit = usd ? Math.round(item.priceMinor * USD_PER_BDT) : item.priceMinor;
    return fixtures.cartLine({ lineId, productId: item.product, variantId: item.variant, sku: item.sku, title: item.title, quantity, unitPriceMinor: unit, lineTotalMinor: unit * quantity, ...extra });
  };
  const cart = (lines: FunctionCart["lines"], usd: boolean) => fixtures.cart({
    lines, attributes,
    ...(usd ? { currency: "USD", decimalPlaces: 2, storeCurrency: { code: "BDT", decimalPlaces: 2 } } : {}),
  });
  const plain = (usd: boolean) => cart([line(0, "line_1", 2, usd), line(1, "line_2", 1, usd)], usd);
  const kit = cart([line(2, "line_kit", 1, false, { requiresShipping: false, bundle: { id: "line_kit", title: "Starter kit", kind: "kit", anchor: true, kit: { variantId: "var_kit", productId: "prod_kit", sku: "KIT-1" } } })], false);
  const answers = Object.fromEntries(Object.entries(settings?.eligible?.properties ?? {}).map(([key, value]) => [`${appId}.${key}`, value]));
  const eligible = (usd: boolean, properties = answers) => cart([line(3, "line_eligible", 2, usd, { requiresShipping: false, properties }), line(0, "line_1", 1, usd)], usd);
  const carts: ReplayCart[] = [
    { label: "plain lines, en, BDT", language: "en", cart: plain(false) },
    { label: "a kit, en, BDT", language: "en", cart: kit },
  ];
  if (!settings?.eligible) {
    carts.push({ label: "plain lines, bn, BDT", language: "bn", cart: plain(false) }, { label: "plain lines, en, USD", language: "en", cart: plain(true) });
    return carts;
  }
  carts.push(
    { label: "eligible line, en, BDT", language: "en", cart: eligible(false) },
    { label: "eligible line, bn, BDT", language: "bn", cart: eligible(false) },
    { label: "eligible line, en, USD", language: "en", cart: eligible(true) },
  );
  if (Object.keys(answers).length > 0) {
    carts.push({
      label: "offers on the eligible line, en, BDT", language: "en", cart: eligible(false, {}),
      offers: Object.entries(answers).map(([key, value], index) => ({ offerId: `offer_${index + 1}`, lineId: "line_eligible", key, value })),
    });
  }
  return carts;
}

/** The input checkout hands `point` for one fixture cart (before the host adds the app's reads and the clock). */
function functionInput(point: Exclude<PluginRunPoint, typeof PLUGIN_EXTENSION_RUN>, fixture: ReplayCart): Record<string, unknown> | null {
  const { cart, language } = fixture;
  if (fixture.offers && point !== "cart.line_prices") return null;
  switch (point) {
    case "cart.line_prices":
      return {
        cart, language,
        lines: cart.lines.map((entry) => ({
          lineId: entry.lineId, source: "base",
          storeUnitPrice: { amountMinor: REPLAY_PRODUCTS.find((item) => item.variant === entry.variantId)!.priceMinor, currency: "BDT" },
          bundle: entry.bundle ? { id: entry.bundle.id, title: entry.bundle.title } : null,
        })),
        ...(fixture.offers ? { offers: fixture.offers } : {}),
      };
    case "cart.validate":
      return { cart, language, contact: null };
    case "checkout.shipping_rates":
      return {
        cart, language,
        rates: [
          { rateId: "rate_standard", name: "Standard delivery", amountMinor: cart.currency === "USD" ? 50 : 6_000, kind: "delivery" },
          { rateId: "rate_pickup", name: "Store pickup", amountMinor: 0, kind: "pickup" },
        ],
      };
    case "checkout.payment_methods":
      return { cart, language, methods: [{ methodId: "cod", name: "Cash on delivery" }, { methodId: "invoice", name: "Pay by invoice", gated: true }] };
    default:
      return { cart, language };
  }
}

/** The input a buyer's page hands the bundle's extension at `target` for one fixture cart (the SDK's `storefrontExtensionInput`). */
function extensionInput(target: StorefrontUiSlot, fixture: ReplayCart, appId: string): Record<string, unknown> | null {
  if (fixture.offers) return null;
  const page = STOREFRONT_UI_SLOT_PAGES[target];
  const base = fixtures.storefrontExtensionInput(target, { language: fixture.language, locale: `${fixture.language}-BD`, currency: fixture.cart.currency });
  const prefix = `${appId}.`;
  return {
    ...base,
    ...(base.cart ? { cart: fixture.cart } : {}),
    // The cart's lines, with the app's own line inputs as the page reads them (the host keeps each app's own).
    ...(page === "cart" ? {
      lines: fixture.cart.lines.map((entry) => fixtures.buyerUiLine({
        lineKey: `line:v3:${entry.productId}:${entry.variantId}:p:none`, productId: entry.productId, variantId: entry.variantId, title: entry.title,
        quantity: entry.quantity, unitPriceMinor: entry.unitPriceMinor, bundle: false,
        inputs: Object.entries(entry.properties).filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, eligible: true, value, decision: false, offers: [] })),
      })),
    } : {}),
  };
}

/** A run's answer in words: the fields it filled (`addOns: 2`, `ui`), or that it changes nothing. */
function answered(value: unknown): string {
  if (value === null || typeof value !== "object") return `ran (${JSON.stringify(value)})`;
  const filled = Object.entries(value as Record<string, unknown>).flatMap(([key, field]) => {
    if (Array.isArray(field)) return field.length > 0 ? [`${key}: ${field.length}`] : [];
    return field === null || field === undefined || field === false ? [] : [key];
  });
  return filled.length > 0 ? `ran (${filled.join(", ")})` : "ran (empty answer)";
}

/**
 * Every function and buyer UI extension the bundle declares, run through the
 * host as checkout and the buyer's pages run them, on a fresh migrated store:
 * the release installed and approved (every feature on unless the replay
 * settings say otherwise, its settings saved, the eligible line's custom
 * fields written as the app would write them), each run's registration read
 * once (so one failure cannot open the circuit for the next fixture), the
 * real `SandboxLoader` over a Worker Loader stand-in that loads the release's
 * own bundle from the bucket stand-in and runs it with the platform's runtime
 * (`invokePluginDefinition`, as the sandbox wrapper does) behind a structured
 * clone each way. `importModule` imports the bundle's `plugin.js` source.
 * The clock is fixed (`REPLAY_NOW`) and outbound HTTP is refused, as
 * `globalOutbound: null` refuses it in the sandbox.
 */
export async function replayFunctions(
  release: PluginRelease,
  settings: ReplaySettings | null,
  importModule: (source: string) => Promise<unknown>,
): Promise<ReplayFunctions> {
  const { sqlite, db } = createSqliteD1Database();
  const realFetch = globalThis.fetch;
  vi.useFakeTimers({ toFake: ["Date"], now: REPLAY_NOW });
  try {
    sqlite.exec("INSERT INTO user (id, name, email, email_verified, role, is_super_admin) VALUES ('owner', 'Owner', 'owner@shop.test', 1, 'admin', 1)");
    for (const item of REPLAY_PRODUCTS) {
      sqlite.prepare("INSERT INTO products (id, name, slug, price_minor, is_active, is_gift_card) VALUES (?, ?, ?, ?, 1, 0)").run(item.product, item.title, item.product, item.priceMinor);
      sqlite.prepare(`INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory, fulfillment_kind)
        VALUES (?, ?, ?, ?, 100, 0, 0, 1, 1, 'physical')`).run(item.variant, item.product, item.sku, item.priceMinor);
    }
    let installation = await installRelease(db, release, { source: "upload", actorUserId: "owner" });
    const appId = installation.pluginId;
    // Approved first (a feature's settings exist only while it is on), then the merchant's settings saved.
    try {
      installation = await activatePlugin(db, appId, {
        actorUserId: "owner", expectedRevision: installation.revision,
        features: settings?.features ?? installation.declaredManifest.features.map((feature) => feature.id),
      });
    } catch (error) {
      return { load: refusalOf(error).map((line) => `approval refused: ${line}`), runs: {}, traces: {} };
    }
    // One settings file may serve several releases: a key a release does not declare is left out, as a stored
    // setting a release dropped is; a value it declares and refuses is a refusal of the run.
    const declared = new Set(installation.manifest.settings.map((field) => field.key));
    const translatable = new Set(installation.manifest.settings.filter((field) => "translatable" in field && field.translatable).map((field) => field.key));
    const own = <T>(values: Record<string, T> | undefined, keys = declared) => Object.fromEntries(Object.entries(values ?? {}).filter(([key]) => keys.has(key)));
    if (settings?.settings || settings?.settingTranslations) {
      try {
        installation = await writePluginSettings(db, appId, own(settings.settings), {
          expectedRevision: installation.revision, credentialEncryptionKey: PLUGIN_TEST_CREDENTIAL_KEY,
          ...(settings.settingTranslations ? { translations: Object.fromEntries(Object.entries(settings.settingTranslations).map(([language, values]) => [language, own(values, translatable)])) } : {}),
        });
      } catch (error) {
        return { load: refusalOf(error).map((line) => `settings refused: ${line}`), runs: {}, traces: {} };
      }
    }
    const fields = pluginBridgeAuthority(installation).customFields;
    for (const [ownerType, ownerId] of [["product", "prod_eligible"], ["variant", "var_eligible"]] as const) {
      const values = Object.fromEntries(Object.entries(settings?.eligible?.[ownerType] ?? {}).filter(([key]) => fields.some((field) => field.ownerType === ownerType && field.key === key)));
      if (Object.keys(values).length > 0) await setPluginCustomFieldValues(db, appId, fields, ownerType, ownerId, values);
    }

    // The isolate: the release's bundle as the bucket holds it, run by the platform's runtime as the sandbox wrapper runs it.
    let call: unknown = null;
    let raw: PluginInvocationResult | null = null;
    let module: Promise<unknown> | null = null;
    const bundle = release.code;
    const loader = {
      get(_id: string, code: () => Promise<{ modules: Record<string, string>; env: unknown; globalOutbound: unknown }>) {
        module ??= code().then((spec) => {
          if (spec.globalOutbound !== null || JSON.stringify(spec.env) !== "{}") throw new Error("The sandbox must cut the network and hand no bindings.");
          return importModule(spec.modules["plugin.js"]!);
        });
        const run = async (invocation: Parameters<typeof invokePluginDefinition>[1], seed: PluginContextSeed) => {
          const loaded = await module!;
          if (invocation.kind === "function") call = structuredClone({ point: invocation.point, input: invocation.input, seed });
          raw = structuredClone(await invokePluginDefinition(loaded, structuredClone(invocation), structuredClone(seed), null));
          return raw;
        };
        return {
          getEntrypoint: () => ({
            invokeFunction: (seed: PluginContextSeed, point: string, input: unknown) => run({ kind: "function", point, input }, seed),
            invokeCheck: (seed: PluginContextSeed) => run({ kind: "check" }, seed),
          }),
        };
      },
    };
    const bucket = {
      get: async (key: string) => key === pluginBundleKey(appId, installation.version, installation.bundleSha256)
        ? { arrayBuffer: async () => bundle.slice().buffer }
        : null,
    };
    const env = pluginTestEnv(undefined as unknown as D1Database, { LOADER: loader, BUCKET: bucket });
    const ctx = { ...pluginTestCtx(), exports: { PluginBridge: () => ({}) } } as unknown as ExecutionContext;
    if (sha256Hex(bundle) !== installation.bundleSha256) throw new Error(`${appId}: the installed bundle hash is not its code's.`);
    globalThis.fetch = (async () => {
      throw new Error(`${appId} is not permitted to access the internet via global fetch(): the sandbox cuts its network (globalOutbound: null).`);
    }) as typeof fetch;

    // The host, watched at its edges: each run's outcome, its incidents (a read that failed) and its word notices.
    const host = new PluginHost({ env, ctx, db });
    const load = await host.checkLoads(installation);
    const result: ReplayFunctions = { load: load.ok ? "loads" : [`${load.failure}: ${load.error}`], runs: {}, traces: {} };
    if (!load.ok) return result;
    let outcome: Awaited<ReturnType<PluginHost["invokeFunction"]>> | null = null;
    let incidents: string[] = [];
    let notices: string[] = [];
    const invokeFunction = host.invokeFunction.bind(host);
    host.invokeFunction = (async (...args: Parameters<PluginHost["invokeFunction"]>) => (outcome = await invokeFunction(...args))) as PluginHost["invokeFunction"];
    const incident = host.incident.bind(host);
    host.incident = async (target, source, message) => {
      incidents.push(message);
      return incident(target, source, message);
    };
    const notice = host.notice.bind(host);
    host.notice = (target, source, messages, now) => {
      notices.push(...messages);
      notice(target, source, messages, now);
    };

    const runOne = async (label: string, point: PluginRunPoint, input: Record<string, unknown>, registered: Awaited<ReturnType<typeof listActiveFunctionPlugins>>, uncounted: boolean) => {
      outcome = null;
      call = null;
      raw = null;
      incidents = [];
      notices = [];
      let blocked = false;
      try {
        await runPluginFunctions(point, input as never, env, ctx, { db, host, registered, defaultLocale: "en", ...(uncounted ? { uncounted } : {}) });
      } catch (error) {
        if (!(error instanceof PluginFunctionsBlockedError)) throw error;
        blocked = true;
      }
      const ran = outcome as Awaited<ReturnType<PluginHost["invokeFunction"]>> | null;
      const lines: string[] = [];
      if (!ran) lines.push(incidents.length > 0 ? `not run: ${incidents.join(" ")}` : "not called");
      else if (ran.ok) lines.push(answered(ran.value), ...notices.map((message) => `the store's word: ${message}`));
      else lines.push(ran.failure === "invalid" ? `refused: ${ran.error}` : ran.failure === "timeout" ? `timed out: ${ran.error}` : ran.failure === "error" ? `threw: ${ran.error}` : `${ran.failure}: ${ran.error}`);
      if (blocked) lines.push("blocking: checkout refuses the order");
      result.runs[label] = lines.length === 1 && (ran?.ok || !ran) ? lines[0]! : lines;
      const own = raw as PluginInvocationResult | null;
      result.traces[label] = { call, answer: ran?.ok ? ran.value : own?.ok ? own.value : null };
    };

    const carts = replayCarts(appId, settings);
    for (const declaration of installation.manifest.functions) {
      const registered = await listActiveFunctionPlugins(db, declaration.point);
      for (const fixture of carts) {
        const input = functionInput(declaration.point, fixture);
        if (input) await runOne(`${declaration.point} · ${fixture.label}`, declaration.point, input, registered, Boolean(fixture.offers));
      }
    }
    if (installation.manifest.storefront.extensions.length > 0) {
      const registered = await listActiveFunctionPlugins(db, PLUGIN_EXTENSION_RUN);
      for (const { target } of installation.manifest.storefront.extensions) {
        for (const fixture of carts) {
          const input = extensionInput(target, fixture, appId);
          if (input) await runOne(`${PLUGIN_EXTENSION_RUN} ${target} · ${fixture.label}`, PLUGIN_EXTENSION_RUN, input, registered, false);
        }
      }
    }
    return result;
  } finally {
    // The host's after-response work (logs, the circuit, staff notices) settles inside the cut network and the clock.
    try {
      await settleBackground();
    } finally {
      globalThis.fetch = realFetch;
      vi.useRealTimers();
      sqlite.close();
    }
  }
}

/** A render job as a page asks the host for it (the host names it). */
type RenderAsk = StorefrontRenderJob extends infer Job ? Job extends unknown ? Omit<Job, "id"> : never : never;

/** One part the storefront would draw, as its render host is asked for it. */
export interface ReplayRenderJob {
  /** `skin <id> (<target>)` or `section <type> #<instance>`. */
  label: string;
  /** The unit `appMarkup` cuts its markup under. */
  unit: StorefrontSkinTarget | "section";
  ask: RenderAsk;
}

export interface ReplayRender {
  /** The app as the layout read lists it once approved (`activePluginStorefrontExtensions`); null when it ships no storefront code. */
  extension: StorefrontExtension | null;
  context: StorefrontRenderContext;
  jobs: ReplayRenderJob[];
}

/**
 * A merchant's filled-in values for a settings schema: every field set
 * (words, the first option, a link, two list items, the newest products, an
 * image), so a part that draws nothing without content is asked to draw.
 * Values the schema refuses fall back to defaults when resolved.
 */
function sampleValues(schema: PluginSettingsSchema): Record<string, unknown> {
  const value = (field: PluginSettingsSchema[number] | Extract<PluginSettingsSchema[number], { type: "list" }>["fields"][number]): unknown => {
    const words = `Sample ${field.label}`;
    switch (field.type) {
      case "text": case "textarea": return words.slice(0, "maxLength" in field && field.maxLength ? field.maxLength : 200);
      case "number": return "default" in field && typeof field.default === "number" ? field.default : "min" in field && typeof field.min === "number" ? field.min : 1;
      case "boolean": return true;
      case "select": return field.default ?? field.options[0]?.value;
      case "multiselect": return field.options.slice(0, 1).map((option) => option.value);
      case "url": return "https://example.com/";
      case "link": return "/";
      case "color": return field.default ?? "#336699";
      case "email": return "store@example.com";
      case "image": return "media_sample";
      case "product": return "prod_sample";
      case "products": return "newest";
      case "list": return [0, 1].map(() => Object.fromEntries(field.fields.map((item) => [item.key, value(item)])));
      default: return undefined;
    }
  };
  return Object.fromEntries(schema.flatMap((field) => {
    const sample = value(field);
    return sample === undefined ? [] : [[field.key, sample]];
  }));
}

/**
 * What the storefront asks the app to draw, over the SDK's sample fixture
 * store, twice: on the applied template's pages (every declared skin with the
 * values the template gives it, else its defaults; each component section
 * the template's homepage places, with its values, and a declared type it
 * does not place once with its defaults), and with sample content (every
 * skin and component section with every setting filled in). A core section's
 * skin always gets the sample store's filled-in section. A template ships
 * empty content for the merchant to fill, so the second pass is the one that
 * asks each part to draw.
 */
export function replayRenderJobs(installation: PluginInstallation, theme: StorefrontThemeDocument): ReplayRender {
  const store = fixtureStore("sample");
  const approved = { ...installation, status: "active" as const, grant: pluginGrantRequest(installation.declaredManifest) };
  const extension = activePluginStorefrontExtensions([approved])[0] ?? null;
  const context = store.context();
  if (!extension) return { extension, context, jobs: [] };
  const own = (key: string | undefined, id: string) => {
    const parsed = key ? parsePluginSurfaceKey(key) : null;
    return parsed?.pluginId === extension.pluginId && parsed.type === id;
  };
  const home = theme.pages.home;
  const jobs: ReplayRenderJob[] = [];
  for (const skin of extension.skins) {
    const unit = theme.apps?.skins?.[skin.target as keyof NonNullable<NonNullable<StorefrontThemeDocument["apps"]>["skins"]>];
    const placed = home.find((section) => (section as { skin?: { app?: string } }).skin && own((section as { skin?: { app?: string } }).skin?.app, skin.id));
    const values = unit && own(unit.app, skin.id) ? unit.values : (placed as { skin?: { values?: unknown } } | undefined)?.skin?.values ?? {};
    const settings = resolveStorefrontSettings(skin.settings, values, { image: () => store.image(), products: () => [] });
    const section = skin.target.startsWith("section:");
    jobs.push({
      label: `skin ${skin.id} (${skin.target})`,
      unit: skin.target,
      ask: {
        kind: "skin", target: skin.target, component: skin.id, settings, data: store.skinData(skin.target),
        ...(section ? { instanceId: placed?.id ?? `replay-${skin.id}` } : {}),
      } as RenderAsk,
    });
  }
  const sectionSettings = (type: string, values: unknown) =>
    resolveStorefrontSettings(extension.sectionSettings[type] ?? [], values, { image: () => store.image(), products: () => store.productCards() });
  const placedTypes = new Set<string>();
  for (const section of home) {
    if (section.type !== "app") continue;
    const settings = section.settings as { app?: string; values?: unknown };
    const parsed = settings.app ? parsePluginSurfaceKey(settings.app) : null;
    if (!parsed || parsed.pluginId !== extension.pluginId || !extension.sections.includes(parsed.type)) continue;
    placedTypes.add(parsed.type);
    jobs.push({
      label: `section ${parsed.type} #${section.id}`,
      unit: "section",
      ask: { kind: "section", type: parsed.type, instanceId: section.id, settings: sectionSettings(parsed.type, settings.values ?? {}) },
    });
  }
  for (const type of extension.sections) {
    if (placedTypes.has(type)) continue;
    jobs.push({
      label: `section ${type} (defaults)`,
      unit: "section",
      ask: { kind: "section", type, instanceId: `replay-${type}`, settings: sectionSettings(type, {}) },
    });
  }
  for (const skin of extension.skins) {
    const section = skin.target.startsWith("section:");
    jobs.push({
      label: `skin ${skin.id} (${skin.target}, sample content)`,
      unit: skin.target,
      ask: {
        kind: "skin", target: skin.target, component: skin.id,
        settings: resolveStorefrontSettings(skin.settings, sampleValues(skin.settings), { image: () => store.image(), products: () => [] }),
        data: store.skinData(skin.target),
        ...(section ? { instanceId: `replay-sample-${skin.id}` } : {}),
      } as RenderAsk,
    });
  }
  for (const type of extension.sections) {
    jobs.push({
      label: `section ${type} (sample content)`,
      unit: "section",
      ask: { kind: "section", type, instanceId: `replay-sample-${type}`, settings: sectionSettings(type, sampleValues(extension.sectionSettings[type] ?? [])) },
    });
  }
  return { extension, context, jobs };
}
