#!/usr/bin/env node
/**
 * pnpm fidelity:check — measures the BUILT storefront against the reference
 * sites (AUDIT.md §8 global bar) and fails on any tolerance breach.
 *
 * It builds the storefront, seeds a 30k-product store into a temp state it
 * owns (or copies a cached one), runs the API and the built storefront under
 * `wrangler dev` with one headless Chrome, applies every template and single
 * variant swap, measures every block at 1440 and 390, and writes pairs, a JSON
 * scorecard and a markdown summary. Every process tree it starts is killed and
 * the temp state is deleted at the end.
 *
 *   pnpm fidelity:check [--only <template|block>[,...]] [--report-only]
 *     [--out <dir>] [--state-cache <dir>] [--skip-build] [--keep-run]
 *     [--api-port 9001] [--storefront-port 4601] [--admin-port 4602] [--media-port 4603] [--chrome-port 9601]
 *     [--ref-shots <dir>[,<dir>]] [--max-swap-mb 7000]
 *
 * Blocks: header, card, listing, pdp, footer, size, perf, nav, variants, hover, tiny.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Chrome } from "./lib/cdp.mjs";
import {
  compareTemplate, exitCode, extractOurs, hoverChecks, navChecks, parseOnly, perfChecks, selected, summarize, variantChecks,
} from "./lib/compare.mjs";
import { DEFAULT_PORTS, HARNESS_DIR, ROOT, TEMPLATES, assertLocalDatabase, assertOwnedState, mainCheckoutRoot, openDb } from "./lib/context.mjs";
import { killAllTracked, listeners, rssSampler, sleep, swapUsedMb } from "./lib/proc.mjs";
import { Stack, buildStorefront, storefrontBuilt } from "./lib/stack.mjs";
import { applyTheme } from "./lib/theme.mjs";
import { runHover } from "./hover.mjs";
import { runMatrix } from "./matrix.mjs";
import { MENUS } from "./menus.mjs";
import { runNavscale } from "./navscale.mjs";
import { writePairs } from "./pairs.mjs";
import { runPerf } from "./perf.mjs";
import { POOL_DIR, STORE_FILE, seedLarge } from "./seed-large.mjs";
import { startMediaServer } from "./lib/media-server.mjs";
import { applyTiny } from "./seed-tiny.mjs";
import { runVariants } from "./variants.mjs";

export const BLOCKS = Object.freeze(["header", "card", "listing", "pdp", "footer", "size", "perf", "nav", "variants", "hover", "tiny"]);
const MATRIX_BLOCKS = ["header", "card", "listing", "pdp", "footer", "size"];

export function parseArgs(argv) {
  const o = { only: "", reportOnly: false, out: join(ROOT, ".wrangler", "fidelity"), stateCache: null, skipBuild: false, keepRun: false, refShots: null, maxSwapMb: 7000, ports: { ...DEFAULT_PORTS } };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--only") o.only = next();
    else if (a === "--report-only") o.reportOnly = true;
    else if (a === "--out") o.out = resolve(next());
    else if (a === "--state-cache") o.stateCache = resolve(next());
    else if (a === "--skip-build") o.skipBuild = true;
    else if (a === "--keep-run") o.keepRun = true;
    else if (a === "--ref-shots") o.refShots = next().split(",").map((p) => resolve(p));
    else if (a === "--max-swap-mb") o.maxSwapMb = Number(next());
    else if (a === "--api-port") o.ports.api = Number(next());
    else if (a === "--storefront-port") o.ports.storefront = Number(next());
    else if (a === "--admin-port") o.ports.admin = Number(next());
    else if (a === "--media-port") o.ports.media = Number(next());
    else if (a === "--chrome-port") o.ports.chrome = Number(next());
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`Unknown argument ${a}`);
  }
  o.ports.apiInspector = 20000 + o.ports.api;
  o.ports.storefrontInspector = 20000 + o.ports.storefront;
  if (new Set([o.ports.api, o.ports.storefront, o.ports.admin, o.ports.media, o.ports.chrome]).size !== 5) throw new Error("ports must differ");
  return o;
}

/** Which measurement stages a filter needs. */
export function stagesFor(filter) {
  const wants = (blocks) => !filter.blocks.length || filter.blocks.some((b) => blocks.includes(b));
  return {
    matrix: wants(MATRIX_BLOCKS),
    variants: wants(["variants"]) && (!filter.templates.length || filter.templates.includes("department-mall")),
    nav: wants(["nav"]),
    perf: wants(["perf", "size"]),
    hover: wants(["hover"]) && (!filter.templates.length || filter.templates.some((t) => ["boutique", "heritage-editorial", "department-mall"].includes(t))),
    tiny: wants(["tiny"]),
  };
}

/** Invalidates a cached seeded state when the seed code or the migrations change. */
export function seedFingerprint() {
  const h = createHash("sha256");
  for (const f of ["seed-large.mjs", "menus.mjs", "pool.mjs"]) h.update(readFileSync(join(HARNESS_DIR, f)));
  h.update(readFileSync(join(ROOT, "scripts", "catalog-scale-seed.mjs")));
  const migrations = join(ROOT, "packages", "database", "migrations");
  for (const f of readdirSync(migrations).filter((n) => n.endsWith(".sql")).sort()) h.update(f).update(readFileSync(join(migrations, f)));
  return h.digest("hex").slice(0, 16);
}

function fmtVal(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return String(Math.round(v * 100) / 100);
  return String(v);
}

export function markdownSummary({ summary, checks, meta, filter }) {
  const lines = [];
  lines.push(`# Storefront fidelity scorecard`, "");
  lines.push(`${meta.finishedAt} · ${meta.git} · ${Math.round(meta.durationS / 60 * 10) / 10} min · peak memory ${meta.peakFootprintMb ?? "-"} MB footprint / ${meta.peakRssMb} MB summed RSS${meta.reportOnly ? " · report-only" : ""}${filter ? ` · only ${filter}` : ""}`, "");
  lines.push(`**${summary.failed === 0 ? "PASS" : "FAIL"}: ${summary.passed}/${summary.total} checks pass, ${summary.failed} breach${summary.failed === 1 ? "" : "es"}.**`, "");
  lines.push("| Template | Pass | Fail |", "|---|---|---|");
  for (const [t, c] of Object.entries(summary.byTemplate)) lines.push(`| ${t} | ${c.pass} | ${c.fail} |`);
  lines.push("", "| Block | Pass | Fail |", "|---|---|---|");
  for (const [b, c] of Object.entries(summary.byBlock)) lines.push(`| ${b} | ${c.pass} | ${c.fail} |`);
  const failed = checks.filter((c) => !c.pass);
  if (failed.length) {
    lines.push("", "## Breaches", "", "| Check | Ours | Reference | Rule | Detail | Source |", "|---|---|---|---|---|---|");
    for (const c of failed) lines.push(`| ${c.id} | ${fmtVal(c.ours)} | ${fmtVal(c.ref)}${c.refSite && c.refSite !== "bar" ? ` (${c.refSite})` : ""} | ${c.rule} | ${c.detail} | ${c.src ?? ""} |`);
  }
  lines.push("", "Tolerances (AUDIT.md §8): heights and widths ±10%, fonts ±1px and weight ±100, columns exact, image ratio ±0.05, products and filters visible ≥ the reference, scroll to 20 products ≤ 1.1× the reference, first product y ≤ the reference + 40px, plus the performance and size budgets.");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 20).join("\n"));
    return 0;
  }
  const filter = parseOnly(opts.only, TEMPLATES, BLOCKS);
  const templates = filter.templates.length ? filter.templates : [...TEMPLATES];
  const stages = stagesFor(filter);
  const reference = JSON.parse(readFileSync(join(HARNESS_DIR, "reference-metrics.json"), "utf8"));
  assertLocalDatabase();
  for (const [name, port] of Object.entries(opts.ports).filter(([k]) => !/Inspector|admin/.test(k))) {
    if (listeners(port).length) throw new Error(`port ${port} (${name}) is in use; stop that process or pass --${name === "chrome" ? "chrome" : name}-port`);
  }

  const started = Date.now();
  const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${m}`);
  const runDir = mkdtempSync(join(tmpdir(), "scalius-fidelity-"));
  const stateDir = join(runDir, "state");
  const shotsDir = join(opts.out, "shots");
  rmSync(opts.out, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });
  const rss = rssSampler(3000);
  let chrome = null;
  let stack = null;
  let db = null;
  let media = null;
  let aborted = null;
  const cleanup = async () => {
    // Keep the last lines of each server log with the report.
    mkdirSync(join(opts.out, "logs"), { recursive: true });
    for (const name of ["api.log", "storefront.log", "chrome.log"]) {
      try { writeFileSync(join(opts.out, "logs", name), readFileSync(join(runDir, name), "utf8").split("\n").slice(-400).join("\n")); } catch { /* best effort */ }
    }
    try { db?.close(); } catch { /* best effort */ }
    db = null;
    await chrome?.stop().catch(() => {});
    await stack?.stop().catch(() => {});
    await media?.close().catch(() => {});
    media = null;
    await killAllTracked();
    if (!opts.keepRun) rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  };
  const onSignal = (sig) => {
    aborted = sig;
    console.error(`\n${sig}: stopping every process tree and removing ${runDir}`);
    cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const swapWatch = setInterval(() => {
    const used = swapUsedMb();
    if (used !== null && used > opts.maxSwapMb && !aborted) {
      aborted = `swap ${used} MB > ${opts.maxSwapMb} MB`;
      console.error(`\nAborting: ${aborted}`);
      cleanup().finally(() => process.exit(3));
    }
  }, 5000);
  swapWatch.unref();

  const results = {};
  const checks = [];
  const stageErrors = [];
  try {
    if (!opts.skipBuild || !storefrontBuilt()) {
      log("astro build (storefront)");
      buildStorefront(join(runDir, "astro-build.log"));
    }
    const fingerprint = seedFingerprint();
    const cached = opts.stateCache && existsSync(join(opts.stateCache, STORE_FILE))
      && JSON.parse(readFileSync(join(opts.stateCache, STORE_FILE), "utf8")).fingerprint === fingerprint;
    if (cached) {
      log(`copying the cached seeded state ${opts.stateCache}`);
      assertOwnedState(opts.stateCache);
      cpSync(opts.stateCache, stateDir, { recursive: true });
    } else {
      log("seeding the 30k-product store");
      const store = await seedLarge({ stateDir, ports: opts.ports, log: (m) => log(m) });
      store.fingerprint = fingerprint;
      writeFileSync(join(stateDir, STORE_FILE), JSON.stringify(store, null, 2));
      if (opts.stateCache) {
        assertOwnedState(opts.stateCache);
        rmSync(opts.stateCache, { recursive: true, force: true });
        cpSync(stateDir, opts.stateCache, { recursive: true });
        log(`cached the seeded state in ${opts.stateCache}`);
      }
    }
    const store = JSON.parse(readFileSync(join(stateDir, STORE_FILE), "utf8"));
    if (["api", "storefront", "admin", "media"].some((k) => store.ports?.[k] !== opts.ports[k])) {
      // Hero banner URLs and the Platform document carry the stack's origins.
      const d = openDb(stateDir);
      const { syncPlatform } = await import("./seed-large.mjs");
      d.prepare("UPDATE hero_sliders SET images = replace(images, ?, ?)").run(`http://localhost:${store.ports.media}/`, `http://localhost:${opts.ports.media}/`);
      d.prepare("DELETE FROM settings WHERE category = 'platform'").run();
      await syncPlatform(d, opts.ports);
      d.close();
    }
    const pages = store.pages;

    log("starting the media server, the API and the built storefront");
    media = await startMediaServer(join(stateDir, POOL_DIR), opts.ports.media);
    stack = new Stack({ stateDir, ports: opts.ports, runDir });
    await stack.start();
    chrome = new Chrome({ port: opts.ports.chrome, profileDir: join(runDir, "chrome"), logFile: join(runDir, "chrome.log") });
    await chrome.start();
    const page = await chrome.newPage(shotsDir);
    db = openDb(stateDir);
    const ctx = { db, stack, page, base: `http://localhost:${opts.ports.storefront}`, shotsDir, log, store };
    // Warm the isolates so the first template is not measured cold.
    await applyTheme(ctx, templates[0], { menu: MENUS["150"] });
    for (const p of [pages.home, pages.plp, pages.pdp]) await fetch(ctx.base + p).then((r) => r.arrayBuffer());

    // A stage that dies with the stack restarts the stack once and resumes
    // where it stopped; a stage that still fails becomes a failing check.
    const runStage = async (name, block, fn) => {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          return await fn();
        } catch (error) {
          await sleep(2000); // a crashing wrangler exits a moment after it stops answering
          const dead = stack.deadReason() ?? ((await stack.healthy()) ? null : "a Worker stopped answering");
          log(`  ${name} failed: ${error.message}${dead ? ` (${dead})` : ""}`);
          if (dead && attempt === 1) {
            log("  restarting the stack and resuming the stage");
            await stack.restart();
            continue;
          }
          stageErrors.push({ id: `*/${block}/-/stage.${name}`, template: "*", block, viewport: "-", metric: `stage.${name}`, rule: "true", ours: false, ref: true, refSite: "bar", src: "the stage must complete", pass: false, detail: `${error.message}${dead ? ` (${dead})` : ""}` });
          return null;
        }
      }
      return null;
    };
    if (stages.matrix) {
      log(`matrix: ${templates.length} templates x {home, category, product} x {1440, 390}`);
      results.matrix = {};
      await runStage("matrix", "card", () => runMatrix(ctx, { templates, pages: { home: pages.home, plp: pages.plp, pdp: pages.pdp }, into: results.matrix }));
    }
    if (stages.variants) {
      log("variants: card and listing swaps on department-mall");
      results.variants = await runStage("variants", "variants", () => runVariants(ctx, { template: "department-mall", path: pages.plp }));
    }
    if (stages.nav) {
      log(`navscale: ${templates.length} templates x 5 menus x {1440, 1280, 1024} + drawer + no-JS`);
      results.nav = {};
      await runStage("navscale", "nav", () => runNavscale(ctx, { templates, into: results.nav }));
    }
    if (stages.perf) {
      log("perf: TTFB miss/hit, phone and desktop LCP/CLS");
      results.perf = {};
      await runStage("perf", "perf", () => runPerf(ctx, { templates, pages: { home: pages.home, plp: pages.plp, pdp: pages.pdp }, into: results.perf }));
      if (templates.includes("department-mall")) {
        const special = Object.fromEntries(["pdp100", "pdplegacy", "pdpvideo", "pdprawvideo"].filter((k) => pages[k]).map((k) => [k, pages[k]]));
        await runStage("perf-special", "perf", () => runPerf(ctx, { templates: ["department-mall"], pages: special, into: results.perf }));
      }
    }
    if (stages.hover) {
      const targets = ["boutique", "heritage-editorial", "department-mall:hover"].filter((t) => templates.includes(t.split(":")[0]));
      log(`hover: ${targets.join(", ")}`);
      results.hover = await runStage("hover", "hover", () => runHover(ctx, { targets, path: pages.plp }));
    }
    if (stages.tiny) {
      log("small catalogue: 20 active products, the 20-link menu");
      const tiny = applyTiny(db);
      log(`  ${tiny.active} public products; leaves ${tiny.leaf14} and ${tiny.leaf6}`);
      results.tinyStore = tiny;
      results.tiny = {};
      await runStage("tiny", "tiny", () => runMatrix(ctx, { templates, pages: { home: "/", leaf14: tiny.leaf14, leaf6: tiny.leaf6 }, viewports: ["desktop"], menu: MENUS["20"], prefix: "small", into: results.tiny }));
    }
    checks.push(...stageErrors);

    // ---- compare
    for (const template of templates) {
      const m = results.matrix?.[template];
      if (m) {
        const ours = Object.fromEntries(["desktop", "phone"].map((v) => [v, extractOurs({ home: m[`home-${v}`], plp: m[`plp-${v}`], pdp: m[`pdp-${v}`] })]));
        checks.push(...compareTemplate(template, ours, reference));
      }
      const perfRows = results.perf?.[template] ?? {};
      const rows = {};
      for (const [name, row] of Object.entries(perfRows)) rows[name] = { ...row, html: { ...row.html, ...(m?.weights?.[name] ?? {}) } };
      if (!results.perf && m?.weights) for (const [name, w] of Object.entries(m.weights)) rows[name] = { html: w };
      checks.push(...perfChecks(template, rows, reference.budgets));
      for (const [menu, r] of Object.entries(results.nav?.[template] ?? {})) checks.push(...navChecks(template, `fid-${menu}`, r, reference.budgets));
      const t = results.tiny?.[template];
      if (t) {
        const groups = t["leaf6-desktop"]?.listing?.facetGroups ?? 0;
        checks.push({ id: `${template}/tiny/desktop/leaf6.filterGroups`, template, block: "tiny", viewport: "desktop", metric: "leaf6.filterGroups", rule: "zero", ours: groups, ref: 0, refSite: "bar", src: "AUDIT §8 slice 3: no filters below 8 results", pass: groups === 0, detail: groups === 0 ? "0" : `${groups} filter groups on a 6-product category` });
        if (template === "boutique") {
          const variant = t["home-desktop"]?.attrs?.["data-header-variant"] ?? null;
          checks.push({ id: "boutique/tiny/desktop/header.variant", template, block: "tiny", viewport: "desktop", metric: "header.variant", rule: "exact", ours: variant, ref: "boutique-inline", refSite: "bar", src: "AUDIT §8 slice 0: boutique-inline fits the real small store", pass: variant === "boutique-inline", detail: variant === "boutique-inline" ? "equal" : `${variant} vs boutique-inline` });
        }
      }
    }
    if (results.variants) checks.push(...variantChecks("department-mall", results.variants.diffs, reference.budgets, results.variants));
    for (const [target, h] of Object.entries(results.hover ?? {})) checks.push(...hoverChecks(target.split(":")[0], h.results, reference.budgets).map((c) => ({ ...c, id: `${target}/${c.block}/${c.viewport}/${c.metric}` })));

    if (results.matrix) {
      const study = join(mainCheckoutRoot(), "audit", "rewrite-2026-09-23");
      const refDirs = opts.refShots ?? [join(study, "storefront-study", "shots"), join(study, "fidelity", "shots")];
      const { made, missing } = await writePairs({ reference, matrix: results.matrix, checks, shotsDir, refDirs, outDir: join(opts.out, "pairs"), templates });
      log(`pairs: ${made.length} written${missing.length ? `, ${missing.length} without a reference screenshot` : ""}${refDirs.some(existsSync) ? "" : " (reference screenshots not found; pass --ref-shots)"}`);
    }
    await page.close();
  } finally {
    clearInterval(swapWatch);
    await cleanup();
  }

  const kept = checks.filter((c) => selected(filter, c.template, c.block));
  const summary = summarize(kept);
  const peak = rss.stop();
  const leftovers = Object.entries(opts.ports).filter(([k]) => !/admin/.test(k)).flatMap(([, p]) => listeners(p));
  let git = "";
  try { git = (await import("node:child_process")).execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(); } catch { /* best effort */ }
  const meta = { finishedAt: new Date().toISOString(), git, durationS: Math.round((Date.now() - started) / 1000), peakRssMb: peak.peakMb, peakFootprintMb: peak.peakFootprintMb, footprintAtPeakMb: peak.breakdown, reportOnly: opts.reportOnly, leftoverListeners: leftovers, runDirRemoved: !existsSync(runDir) };
  writeFileSync(join(opts.out, "scorecard.json"), JSON.stringify({ meta, filter: opts.only || null, summary, checks: kept, results }, null, 1));
  writeFileSync(join(opts.out, "summary.md"), markdownSummary({ summary, checks: kept, meta, filter: opts.only }));
  console.log(`\n${summary.failed === 0 ? "PASS" : "FAIL"}: ${summary.passed}/${summary.total} checks pass (${meta.durationS}s, peak memory ${peak.peakFootprintMb ?? "-"} MB footprint, ${peak.peakMb} MB summed RSS)`);
  for (const [b, c] of Object.entries(summary.byBlock)) console.log(`  ${b.padEnd(9)} ${String(c.pass).padStart(4)} pass ${String(c.fail).padStart(4)} fail`);
  if (peak.breakdown) console.log(`  memory at the peak (MB footprint): ${Object.entries(peak.breakdown).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`\nScorecard: ${join(opts.out, "scorecard.json")}\nSummary:   ${join(opts.out, "summary.md")}\nPairs:     ${join(opts.out, "pairs")}`);
  if (leftovers.length) console.error(`warning: something still listens on the harness ports (pids ${leftovers.join(", ")})`);
  return exitCode(kept, { reportOnly: opts.reportOnly });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then((code) => process.exit(code), async (error) => {
    console.error(error instanceof Error ? error.stack : error);
    await killAllTracked();
    process.exit(1);
  });
}
