#!/usr/bin/env node
/**
 * pnpm quality:admin: the dashboard quality audit (docs/ADMIN-QUALITY.md).
 *
 * Signs in to a running dashboard with the local test admin, walks every
 * route of apps/admin-v2 (from routeTree.gen.ts, with real ids for the
 * dynamic ones) and every named surface (dialogs and sheets) at 390, 768 and
 * 1440 px in English and Bangla, and checks: axe WCAG 2.2 AA, overflow,
 * clipped text, control heights, field alignment, leaked values, wrong
 * language, console and network errors, layout shift, load timing,
 * interaction latency, keyboard focus and skeleton shape.
 *
 *   pnpm quality:admin [--base-url http://localhost:4323/admin]
 *     [--routes /admin/products*,orders] [--family products,settings]
 *     [--widths 390,768,1440] [--locales en,bn] [--out .quality/admin]
 *     [--concurrency 3] [--no-shots] [--no-surfaces] [--list]
 *
 * Exit code 1 on any gating finding that is not in
 * scripts/admin-quality/allowlist.json. It starts nothing: the stack runs
 * already (or use the worker UI preview, docs/ADMIN-QUALITY.md).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { globMatch } from "./quality-shared/page-checks.mjs";
import { summarizeResults } from "./quality-shared/report-kit.mjs";
import { writeQualityReport } from "./storefront-quality/report.mjs";
import { auditPage, compileLanguageAllowlist, errorScreenPatterns } from "./admin-quality/audit.mjs";
import { readAdminCredentials, signInStorageState } from "./admin-quality/auth.mjs";
import { TIMING_INIT } from "./admin-quality/page-facts.mjs";
import { resolveParams } from "./admin-quality/params.mjs";
import { buildPlan, fillPath, filterRoutes, pageUrl, paramNames, parseLeafRoutes, parseList } from "./admin-quality/routes.mjs";
import { CLS_INIT } from "./quality-shared/page-checks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const DEFAULT_BASE_URL = "http://localhost:4323/admin";
const LOCALE_KEY = "scalius.dashboard.locale";
const JOB_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  const args = { baseUrl: DEFAULT_BASE_URL, routes: [], families: [], widths: [390, 768, 1440], locales: ["en", "bn"], out: join(ROOT, ".quality/admin"), concurrency: 3, shots: true, surfaces: true, list: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--base-url") args.baseUrl = value().replace(/\/$/, "");
    else if (flag === "--routes") args.routes = parseList(value());
    else if (flag === "--family") args.families = parseList(value());
    else if (flag === "--widths") args.widths = parseList(value()).map(Number).filter((width) => width > 0);
    else if (flag === "--locales") args.locales = parseList(value());
    else if (flag === "--out") args.out = resolve(value());
    else if (flag === "--concurrency") args.concurrency = Math.max(1, Number(value()) || 1);
    else if (flag === "--no-shots") args.shots = false;
    else if (flag === "--no-surfaces") args.surfaces = false;
    else if (flag === "--list") args.list = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`Unknown flag ${flag}`);
  }
  for (const locale of args.locales) if (!["en", "bn"].includes(locale)) throw new Error(`--locales takes en and bn, got ${locale}`);
  return args;
}

function loadJson(path) {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
}

function loadAllowlist() {
  const raw = loadJson("scripts/admin-quality/allowlist.json");
  for (const item of raw.findings) if (!item.entry || !item.rule || !item.reason?.trim()) throw new Error(`Allowlist findings need entry, rule and a reason: ${JSON.stringify(item)}`);
  for (const item of [...raw.network, ...raw.console]) if (!item.reason?.trim()) throw new Error(`Allowlist items need a reason: ${JSON.stringify(item)}`);
  return raw;
}

function allowed(list, entryId, rule, width, locale) {
  return list.find((item) => globMatch(item.entry, entryId) && globMatch(item.rule, rule) && (!item.widths || item.widths.includes(width)) && (!item.locales || item.locales.includes(locale))) ?? null;
}

/** One context per worker, route-bound: signed in or signed out, one language, own-origin traffic only. */
async function workerContext(browser, { storageState, locale, publicPage, baseOrigin }) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: "reduce",
    ...(publicPage ? {} : { storageState }),
  });
  await context.addInitScript(([key, value]) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Storage is off: the dashboard starts in English.
    }
  }, [LOCALE_KEY, locale]);
  await context.addInitScript(CLS_INIT);
  await context.addInitScript(TIMING_INIT);
  await context.route((url) => !url.href.startsWith(baseOrigin), (route) => route.abort());
  return context;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function percentile(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 24).join("\n"));
    return 0;
  }
  const allowlist = loadAllowlist();
  const languageAllow = compileLanguageAllowlist(loadJson("scripts/admin-quality/language-allowlist.json"));
  const surfaces = args.surfaces ? loadJson("scripts/admin-quality/surfaces.json") : [];
  const errorTitles = errorScreenPatterns(readFileSync(join(ROOT, "apps/admin-v2/src/i18n/app.ts"), "utf8"));
  const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
  const baseOrigin = new URL(args.baseUrl).origin;
  const started = Date.now();

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const cleanup = async () => {
    await browser.close().catch(() => {});
  };
  process.once("SIGINT", () => cleanup().then(() => process.exit(130)));
  try {
    // Sign in once; the session is saved as a Playwright storage state.
    mkdirSync(join(args.out, "auth"), { recursive: true });
    const stateFile = join(args.out, "auth/state.json");
    const storageState = await signInStorageState(browser, baseOrigin, readAdminCredentials(ROOT));
    writeFileSync(stateFile, JSON.stringify(storageState), { mode: 0o600 });

    // Routes, with one real id per resource.
    const treeSource = readFileSync(join(ROOT, "apps/admin-v2/src/routeTree.gen.ts"), "utf8");
    const leafPaths = filterRoutes(parseLeafRoutes(treeSource), { routes: args.routes, families: args.families });
    // A surface runs with no filter, with `--family surface`, or when `--routes` names it (`surface:<id>`) or its route.
    const surfaceJobsWanted = surfaces.filter((surface) => {
      if (args.routes.length === 0 && args.families.length === 0) return true;
      if (args.families.includes("surface")) return true;
      return args.families.length === 0 && filterRoutes([`surface:${surface.id}`, surface.route], { routes: args.routes }).length > 0;
    });
    const wantedNames = [...new Set([...leafPaths, ...surfaceJobsWanted.map((surface) => surface.route)].flatMap(paramNames))];
    const apiContext = await browser.newContext({ storageState });
    const getJson = async (path) => {
      const response = await apiContext.request.get(`${baseOrigin}${path}`, { headers: { origin: baseOrigin } });
      if (!response.ok()) throw new Error(`${path} answered ${response.status()}`);
      return await response.json();
    };
    const { resolved, unresolved } = await resolveParams(wantedNames, getJson);
    await apiContext.close();
    const plan = buildPlan({ paths: leafPaths, resolved, unresolved });

    const jobs = plan.routes.map((route) => ({ id: route.path.replace(/[^a-z0-9$]+/gi, "-").replace(/^-|-$/g, "") || "home", title: route.path, family: route.family, path: route.path, url: pageUrl(args.baseUrl, route.url), public: route.public }));
    const surfaceSkips = [];
    for (const surface of surfaceJobsWanted) {
      const missing = paramNames(surface.route).filter((name) => !resolved[name]);
      if (missing.length) {
        surfaceSkips.push({ path: `surface:${surface.id}`, reason: unresolved[missing[0]] ?? `no value for :${missing[0]}` });
        continue;
      }
      jobs.push({ id: `surface-${surface.id}`, title: `${surface.title} (${surface.route})`, family: "surface", path: surface.route, url: pageUrl(args.baseUrl, fillPath(surface.route, resolved)), public: false, surface });
    }
    const skipped = [...plan.skipped, ...surfaceSkips];
    const variants = args.widths.flatMap((width) => args.locales.map((locale) => ({ width, locale })));
    console.log(`${jobs.length} routes and surfaces x ${variants.length} variants (${args.widths.join(", ")} px; ${args.locales.join(", ")}); ${skipped.length} skipped; ${args.concurrency} at a time`);
    if (args.list) {
      for (const job of jobs) console.log(`  ${job.family.padEnd(14)} ${job.url}`);
      for (const item of skipped) console.log(`  skipped ${item.path}: ${item.reason}`);
      return 0;
    }

    rmSync(join(args.out, "shots"), { recursive: true, force: true });
    mkdirSync(args.out, { recursive: true });

    // Work items: a job at one locale keeps one context per worker and locale.
    const work = jobs.flatMap((job) => args.locales.filter((locale) => !job.surface?.locales || job.surface.locales.includes(locale)).map((locale) => ({ job, locale })));
    const results = new Map();
    let next = 0;
    let done = 0;
    await Promise.all(Array.from({ length: Math.min(args.concurrency, work.length) }, async () => {
      const contexts = new Map();
      const contextFor = async (item) => {
        const key = `${item.locale}|${item.job.public}`;
        if (!contexts.has(key)) contexts.set(key, await workerContext(browser, { storageState, locale: item.locale, publicPage: item.job.public, baseOrigin }));
        return contexts.get(key);
      };
      while (next < work.length) {
        const item = work[next++];
        const entryKey = item.job.id;
        const entry = results.get(entryKey) ?? { id: item.job.id, family: item.job.family, title: item.job.title, page: item.job.surface ? "surface" : item.job.family, locale: args.locales.join("/"), dir: "ltr", url: item.job.url, failing: false, allowlisted: false, allowReason: null, error: null, widths: {}, fallbacks: [], unanswered: [] };
        results.set(entryKey, entry);
        for (const width of args.widths) {
          const key = `${width} ${item.locale}`;
          try {
            const context = await contextFor(item);
            const audited = await Promise.race([
              auditPage({ context, job: item.job, width, locale: item.locale, baseOrigin, axeSource, allowlist, languageAllow, errorTitles, out: args.out, shots: args.shots }),
              new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${JOB_TIMEOUT_MS / 1000} s`)), JOB_TIMEOUT_MS)),
            ]);
            for (const found of audited.findings) {
              const allow = found.gating ? allowed(allowlist.findings, item.job.path, found.rule, width, item.locale) : null;
              found.gating = found.gating && !allow;
              if (allow) {
                found.allowlisted = allow.reason;
                entry.allowlisted = true;
                entry.allowReason = allow.reason;
              }
            }
            entry.widths[key] = { screenshot: audited.screenshot, diff: null, metrics: audited.metrics, findings: audited.findings };
          } catch (error) {
            entry.error = `${key}: ${String(error?.stack ?? error).slice(0, 1500)}`;
            // A failed context may be unusable: build a fresh one next time.
            for (const context of contexts.values()) await context.close().catch(() => {});
            contexts.clear();
          }
        }
        entry.failing = Boolean(entry.error) || Object.values(entry.widths).some((variant) => variant.findings.some((found) => found.gating));
        done += 1;
        if (entry.failing || done % 20 === 0) console.log(`[${done}/${work.length}] ${entry.failing ? "FAIL" : "ok  "} ${item.job.id} (${item.locale})${entry.error ? ` error: ${entry.error.split("\n")[0]}` : ""}`);
      }
      for (const context of contexts.values()) await context.close().catch(() => {});
    }));

    const entries = jobs.map((job) => results.get(job.id)).filter(Boolean);
    const summary = summarizeResults(entries, { ignoreRules: ["screenshot"] });
    summary.skipped = skipped;
    const all = entries.flatMap((entry) => Object.values(entry.widths).map((variant) => variant.metrics));
    summary.timing = {
      firstRenderMs: { median: median(all.map((m) => m.fcpMs)), p95: percentile(all.map((m) => m.fcpMs), 0.95) },
      settledMs: { median: median(all.map((m) => m.settledMs)), p95: percentile(all.map((m) => m.settledMs), 0.95) },
    };
    const report = {
      title: "Dashboard quality report", generatedAt: new Date().toISOString(), baseUrl: args.baseUrl, mode: "base-url",
      widths: args.widths.flatMap((width) => args.locales.map((locale) => `${width} ${locale}`)),
      durationSeconds: Math.round((Date.now() - started) / 1000), summary, entries,
    };
    writeFileSync(join(args.out, "results.json"), `${JSON.stringify(report, null, 2)}\n`);
    const reportFile = writeQualityReport(args.out, report);
    console.log(`\n${summary.entries} routes and surfaces, ${summary.failingEntries} failing, ${summary.gatingFindings} gating findings (${report.durationSeconds}s)`);
    for (const [rule, value] of Object.entries(summary.byRule).slice(0, 30)) {
      console.log(`  ${rule.padEnd(24)} ${String(value.findings).padStart(6)} findings in ${String(value.entries).padStart(4)} routes${value.gating ? "  (gating)" : ""}`);
    }
    for (const item of skipped) console.log(`  skipped ${item.path}: ${item.reason}`);
    console.log(`Report: ${reportFile}`);
    return summary.failingEntries > 0 ? 1 : 0;
  } finally {
    await cleanup();
  }
}

main().then((code) => process.exit(code), (error) => {
  console.error(error);
  process.exit(2);
});
