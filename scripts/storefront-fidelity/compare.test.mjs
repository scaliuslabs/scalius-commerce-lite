import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { poolFile } from "./lib/media-server.mjs";
import {
  DEFAULT_TOLERANCES, METRIC_RULES, compareTemplate, exitCode, extractOurs, htmlBudgetKb, judge, median, navChecks,
  parseFont, parseOnly, perfChecks, selected, summarize, variantChecks,
} from "./lib/compare.mjs";
import { TEMPLATES, loadSharp } from "./lib/context.mjs";
import { MENUS, TEMPLATE_MENUS } from "./menus.mjs";
import { BLOCKS, marketplaceLayoutChecks, markdownSummary, parseArgs, resolveTemplatePdpCandidates, stagesFor } from "./check.mjs";
import { referenceShotIssue, writePairs } from "./pairs.mjs";

const reference = JSON.parse(readFileSync(new URL("./reference-metrics.json", import.meta.url), "utf8"));

it("uses relevant category menus for reference captures while retaining scale navigation", () => {
  expect(TEMPLATE_MENUS.boutique).toBe("menu_fid_fashion");
  expect(TEMPLATE_MENUS["daily-essentials"]).toBe("menu_fid_pantry");
  expect(TEMPLATE_MENUS.marketplace ?? MENUS["150"]).toBe(MENUS["150"]);
});

it("selects a buyer-resolvable inheriting PDP with the template's option and media shape", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE products (id TEXT, slug TEXT, name TEXT, category_id TEXT, page_template TEXT, is_active INTEGER, deleted_at INTEGER);
    CREATE TABLE categories (id TEXT, name TEXT, parent_id TEXT);
    CREATE TABLE product_buyer_state (product_id TEXT, is_public INTEGER, available_for_sale INTEGER, has_discount INTEGER);
    CREATE TABLE product_media (product_id TEXT, media_id TEXT, is_primary INTEGER);
    CREATE TABLE media (id TEXT, kind TEXT);
    CREATE TABLE product_option_definitions (product_id TEXT, deleted_at INTEGER);
    CREATE TABLE product_variants (product_id TEXT, deleted_at INTEGER);
    CREATE TABLE product_attribute_values (product_id TEXT, attribute_id TEXT, value TEXT);
    CREATE TABLE product_attributes (id TEXT, name TEXT, key_spec INTEGER);
    INSERT INTO categories VALUES ('ssd', 'SSD', NULL);
    INSERT INTO products VALUES ('a', 'overridden', 'Test SSD Override', 'ssd', 'classic', 1, NULL), ('b', 'inherited', 'Test SSD Inherited', 'ssd', NULL, 1, NULL);
    INSERT INTO product_buyer_state VALUES ('a', 1, 1, 0), ('b', 1, 1, 0);
    INSERT INTO media VALUES ('photo', 'image');
    INSERT INTO product_media VALUES ('a', 'photo', 1), ('a', 'photo', 0), ('a', 'photo', 0), ('b', 'photo', 1), ('b', 'photo', 0), ('b', 'photo', 0);
    INSERT INTO product_option_definitions VALUES ('a', NULL), ('b', NULL);
    INSERT INTO product_variants VALUES ('a', NULL), ('b', NULL);`);
  expect(resolveTemplatePdpCandidates(db, ["marketplace"]).marketplace).toMatchObject({ path: "/products/inherited", images: 3, axes: 1 });
  db.exec(`INSERT INTO categories VALUES ('home', 'Home Storage', NULL);
    INSERT INTO products VALUES ('home', 'fidelity-home-colourful-storage-box', 'Colourful Storage Box', 'home', NULL, 1, NULL);
    INSERT INTO product_buyer_state VALUES ('home', 1, 1, 0);
    INSERT INTO product_media VALUES ('home', 'photo', 1), ('home', 'photo', 0);
    INSERT INTO product_variants VALUES ('home', NULL);`);
  expect(resolveTemplatePdpCandidates(db, ["boutique"]).boutique).toMatchObject({ path: "/products/fidelity-home-colourful-storage-box", images: 2, axes: 0 });
  db.exec("UPDATE products SET page_template = 'classic' WHERE id = 'b'");
  expect(() => resolveTemplatePdpCandidates(db, ["marketplace"])).toThrow("No buyer-resolvable SSD PDP for marketplace");
  db.close();
});

describe("tolerance rules (AUDIT §8 global bar)", () => {
  it("reads computed font strings", () => {
    expect(parseFont("14/600")).toEqual({ size: 14, weight: 600 });
    expect(parseFont("17.9584/800")).toEqual({ size: 17.9584, weight: 800 });
    expect(parseFont("16/normal")).toEqual({ size: 16, weight: 400 });
    expect(parseFont(null)).toBeNull();
    expect(parseFont("large")).toBeNull();
  });

  it("holds heights and widths to ±10%, never tighter than 2px", () => {
    expect(judge("size", 110, 100).pass).toBe(true);
    expect(judge("size", 90, 100).pass).toBe(true);
    expect(judge("size", 111, 100).pass).toBe(false);
    expect(judge("size", 88.9, 100).pass).toBe(false);
    expect(judge("size", 20, 18).pass).toBe(true); // 1.8px would be the 10% band; 2px floor
    expect(judge("size", 21, 18).pass).toBe(false);
    expect(judge("size", 333, 665).detail).toContain("-49.9%");
  });

  it("allows 4px on gaps, whatever the reference", () => {
    expect(judge("gap", 4, 0).pass).toBe(true);
    expect(judge("gap", 10, 0).pass).toBe(false);
    expect(judge("gap", 12, 16).pass).toBe(true);
  });

  it("holds fonts to ±1px and weight ±100", () => {
    expect(judge("font", "15/500", "14/600").pass).toBe(true);
    expect(judge("font", "13/700", "14/600").pass).toBe(true);
    expect(judge("font", "16/600", "14/600").pass).toBe(false);
    expect(judge("font", "14/800", "14/600").pass).toBe(false);
    expect(judge("font", "17.9584/800", "18/800").pass).toBe(true);
    expect(judge("font", "30/600", "22/400").detail).toBe("size +8px (±1), weight +200 (±100)");
  });

  it("wants columns exact and image ratio within ±0.05", () => {
    expect(judge("exact", 4, 4).pass).toBe(true);
    expect(judge("exact", 5, 4).pass).toBe(false);
    expect(judge("ratio", 1.35, 1.31).pass).toBe(true);
    expect(judge("ratio", 1, 1.31).pass).toBe(false);
    expect(judge("ratio", 0.8, 0.75).pass).toBe(true);
  });

  it("wants products and filters visible at least as the reference", () => {
    expect(judge("min", 7, 7).pass).toBe(true);
    expect(judge("min", 2, 7).pass).toBe(false);
    expect(judge("min", 0, 0).pass).toBe(true);
  });

  it("allows scroll to 20 products up to 1.1x and the first product 40px lower", () => {
    expect(judge("scroll", 2636, 2397).pass).toBe(true);
    expect(judge("scroll", 2640, 2397).pass).toBe(false);
    expect(judge("firstY", 404, 364).pass).toBe(true);
    expect(judge("firstY", 405, 364).pass).toBe(false);
    expect(judge("firstY", 100, 364).pass).toBe(true);
  });

  it("fails a measurement that is missing on our page", () => {
    for (const rule of ["size", "font", "min", "scroll", "firstY", "max", "zero", "ratio"]) {
      expect(judge(rule, null, 10).pass).toBe(false);
      expect(judge(rule, undefined, 10).detail).toBe("missing on our page");
    }
    expect(judge("size", Number.NaN, 10).pass).toBe(false);
  });

  it("judges budgets and zero rules", () => {
    expect(judge("max", 120, 120).pass).toBe(true);
    expect(judge("max", 120.1, 120).pass).toBe(false);
    expect(judge("zero", 0, 0).pass).toBe(true);
    expect(judge("zero", 3, 0).pass).toBe(false);
    expect(judge("true", true, true).pass).toBe(true);
    expect(judge("true", false, true).pass).toBe(false);
    expect(() => judge("nope", 1, 1)).toThrow(/unknown rule/);
  });
});

const probe = (over = {}) => ({
  headerRows: [{ h: 83 }, { h: 51 }],
  search: { w: 679, h: 44 },
  footer: { h: 1215 },
  ...over,
});
const plpProbe = {
  card: { w: 213, h: 333, cols: 4, gap: 10, media: { ratio: 1 }, title: { font: "14/600" }, price: { font: "17/600" } },
  density: { cols: 4, firstCardTop: 441, productsFullyHalfVisible: 4, filterControlsVisible: 2, bottomOf20: 2146 },
  facets: { columnW: 236, rowPitch: 44 },
};
const pdpProbe = { h1: { font: "30/600" }, pdp: { price: "30/600", stage: { w: 404, h: 539 }, buttons: [{ text: "Add to cart", w: 290, h: 44 }], buyTop: 520 } };

describe("our metrics from probe results", () => {
  it("maps the probe onto the reference metric keys", () => {
    const ours = extractOurs({ home: probe(), plp: plpProbe, pdp: pdpProbe });
    expect(ours).toMatchObject({
      "header.h": 134, "header.search.w": 679, "card.w": 213, "card.h": 333, "card.cols": 4, "card.gap": 10, "card.ratio": 1,
      "card.title": "14/600", "listing.firstCardY": 441, "listing.filtersVisible": 2, "listing.bottomOf20": 2146,
      "listing.filterColumnW": 236, "listing.filterRowPitch": 44, "pdp.h1": "30/600", "pdp.stage.w": 404, "pdp.stage.h": 539, "pdp.cta.w": 290, "pdp.buyTop": 520, "footer.h": 1215,
    });
    for (const key of Object.keys(METRIC_RULES)) expect(key in ours).toBe(true);
  });

  it("measures the whole sidebar, including its padding", () => {
    const ours = extractOurs({ plp: { ...plpProbe, listing: { filterBox: { w: 270 } } } });
    expect(ours["listing.filterColumnW"]).toBe(270);
  });

  it("reports missing elements as null, and a one-column list as gap 0", () => {
    const ours = extractOurs({ home: { headerRows: [] }, plp: { density: { cols: 1 }, card: { w: 358 } }, pdp: {} });
    expect(ours["header.h"]).toBeNull();
    expect(ours["header.search.w"]).toBeNull();
    expect(ours["card.gap"]).toBe(0);
    expect(ours["pdp.h1"]).toBeNull();
    expect(extractOurs()["card.w"]).toBeNull();
  });

  it("can measure search cards while keeping category listing metrics", () => {
    const search = { card: { w: 1100, h: 280, title: { font: "18/400" } }, density: { cols: 1 } };
    const ours = extractOurs({ plp: plpProbe, cardPage: search });
    expect(ours).toMatchObject({ "card.w": 1100, "card.h": 280, "card.cols": 1, "card.title": "18/400", "listing.firstCardY": 441 });
  });
});

describe("template comparison", () => {
  const ours = { desktop: extractOurs({ home: probe(), plp: plpProbe, pdp: pdpProbe }), phone: {} };

  it("checks every metric of the mapped reference site, per block", () => {
    const checks = compareTemplate("department-mall", ours, reference);
    const byMetric = Object.fromEntries(checks.filter((c) => c.viewport === "desktop").map((c) => [c.metric, c]));
    expect(byMetric["card.w"]).toMatchObject({ refSite: "gameghor", block: "card" });
    expect(byMetric["listing.filtersVisible"]).toMatchObject({ ours: 2, pass: false });
    expect(byMetric["pdp.buyTop"]).toMatchObject({ ref: 400, pass: false });
    expect(byMetric["header.h"].refSite).toBe("gameghor");
    expect(checks.every((c) => c.id === `${c.template}/${c.block}/${c.viewport}/${c.metric}`)).toBe(true);
    // phone metrics exist in the reference but nothing was measured: every one fails as missing
    expect(checks.filter((c) => c.viewport === "phone").every((c) => !c.pass)).toBe(true);
  });

  it("judges filters visible only on large-catalogue templates", () => {
    const small = { ...reference, templates: { ...reference.templates, "department-mall": { ...reference.templates["department-mall"], largeCatalogue: false } } };
    expect(compareTemplate("department-mall", ours, reference).some((c) => c.metric === "listing.filtersVisible")).toBe(true);
    expect(compareTemplate("department-mall", ours, small).some((c) => c.metric === "listing.filtersVisible")).toBe(false);
  });

  it("uses Amazon for the marketplace header and cards", () => {
    const checks = compareTemplate("marketplace", ours, reference);
    expect(checks.find((c) => c.metric === "header.h" && c.viewport === "desktop").refSite).toBe("amazon");
    expect(checks.find((c) => c.metric === "card.w" && c.viewport === "desktop").refSite).toBe("amazon");
  });

  it("refuses an unmapped template", () => {
    expect(() => compareTemplate("nope", ours, reference)).toThrow(/no reference mapping/);
  });
});

describe("marketplace category and search layout", () => {
  const rows = {
    "plp-desktop": { density: { cols: 5 } },
    "search-desktop": { density: { cols: 1 } },
    "plp-phone": { density: { cols: 2 } },
    "search-phone": { density: { cols: 1 } },
  };

  it("checks category grid and search list separately at both widths", () => {
    const checks = marketplaceLayoutChecks(rows);
    expect(checks).toHaveLength(4);
    expect(checks.every((check) => check.pass && check.block === "listing")).toBe(true);
    expect(checks.map((check) => [check.id, check.ours, check.ref])).toEqual([
      ["marketplace/listing/desktop/listing.categoryGridCols", 5, 2],
      ["marketplace/listing/desktop/listing.searchListCols", 1, 1],
      ["marketplace/listing/phone/listing.categoryGridCols", 2, 2],
      ["marketplace/listing/phone/listing.searchListCols", 1, 1],
    ]);
  });

  it("fails a collapsed category grid, multi-column search, or missing probe", () => {
    const checks = marketplaceLayoutChecks({
      ...rows,
      "plp-desktop": { density: { cols: 1 } },
      "search-phone": { density: { cols: 2 } },
      "plp-phone": {},
    });
    expect(checks.map((check) => check.pass)).toEqual([false, true, false, false]);
    expect(checks[2].detail).toBe("missing on our page");
  });
});

describe("budgets", () => {
  it("takes the median TTFB and applies the page-type HTML budget", () => {
    expect(median([418, 1198, 172])).toBe(418);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([null, undefined])).toBeNull();
    expect(htmlBudgetKb("pdp100", reference.budgets)).toBe(120);
    expect(htmlBudgetKb("plp", reference.budgets)).toBe(150);
    expect(htmlBudgetKb("home", reference.budgets)).toBeNull();
    const checks = perfChecks("boutique", {
      pdp: { ttfb: [{ miss: 140, hit: 4 }, { miss: 900, hit: 5 }, { miss: 150, hit: 60 }], phone: { lcp: 7160, cls: 0 }, desktop: { lcp: 68, cls: 0.06 }, html: { bytes: 226 * 1024, headerBytes: 30 * 1024, jsonLdBytes: 89 * 1024, headerAnchors: 197 } },
      home: { html: { bytes: 400 * 1024, headerBytes: 10 } },
    }, reference.budgets);
    const get = (m, page = "pdp") => checks.find((c) => c.metric === m && c.viewport === page);
    expect(get("ttfb.missMs")).toMatchObject({ ours: 150, pass: true });
    expect(get("ttfb.hitMs")).toMatchObject({ ours: 5, pass: true });
    expect(get("phone.lcpMs").pass).toBe(false);
    expect(get("desktop.cls").pass).toBe(false);
    expect(get("html.kb")).toMatchObject({ ours: 226, ref: 120, pass: false, block: "size" });
    expect(get("header.kb").pass).toBe(true);
    expect(get("jsonLd.kb").pass).toBe(false);
    expect(get("header.anchors").pass).toBe(false);
    expect(get("html.kb", "home")).toBeUndefined();
    expect(get("jsonLd.kb", "home")).toBeUndefined();
  });

  it("checks navigation at scale: a menu never disappears, nothing clips, no duplicates", () => {
    const r = {
      d1440: { nav: { visibleLinks: 0, clipped: [] }, headerLinks: 8, headerBytes: 10000, menuLinks: 0 },
      d1024: { nav: { visibleLinks: 3, clipped: [{ text: "Desk & M" }] }, menuLinks: 12 },
      noJsDesktop: { nav: { clipped: 40 } },
      drawer: { visibleRows: 13, duplicates: ["Footwear", "Track your order"] },
    };
    const checks = navChecks("boutique", "fid-live", r, reference.budgets);
    const f = (m) => checks.find((c) => c.id.endsWith(m));
    expect(f("d1440/fid-live.menuLinks").pass).toBe(false);
    expect(f("d1024/fid-live.menuLinks").pass).toBe(true);
    expect(f("d1024/fid-live.clipped")).toMatchObject({ ours: 1, pass: false });
    expect(f("d1440/fid-live.headerAnchors").pass).toBe(true);
    expect(f("d1440-nojs/fid-live.clipped").pass).toBe(false);
    expect(f("phone/fid-live.drawerDuplicates")).toMatchObject({ ours: 2, pass: false });
  });

  it("wants card photos at most 1.2x their drawn width, and plain cards whole with phone titles at the floor", () => {
    const checks = variantChecks("department-mall", reference.budgets, {
      photos: [{ variant: "none+none", viewport: "desktop", drawn: 204, fetched: 240, ratio: 1.18 }, { variant: "delivery+full", viewport: "desktop", drawn: 241, fetched: 320, ratio: 1.33 }, { variant: "delivery+full", viewport: "phone", ratio: 2 }],
      plain: { "none+none-phone": { box: { w: 180, h: 400 }, empty: false, titleFontPx: 13 }, "delivery+full-desktop": { box: { w: 250, h: 0 }, empty: true, titleFontPx: 14 } },
    });
    const f = (suffix) => checks.find((c) => c.id.endsWith(suffix));
    expect(f("desktop/card.none+none.photoRatio").pass).toBe(true);
    expect(f("desktop/card.delivery+full.photoRatio").pass).toBe(false);
    expect(checks.some((c) => c.id.endsWith("phone/card.delivery+full.photoRatio"))).toBe(false);
    expect(f("phone/card.none+none.titlePx").pass).toBe(false);
    expect(f("phone/card.none+none.plainRenders").pass).toBe(true);
    expect(f("desktop/card.delivery+full.plainRenders").pass).toBe(false);
  });
});

describe("filters, verdict and exit code", () => {
  it("parses --only into templates and blocks and rejects unknown names", () => {
    expect(parseOnly("department-mall,listing", TEMPLATES, BLOCKS)).toEqual({ templates: ["department-mall"], blocks: ["listing"] });
    expect(parseOnly("", TEMPLATES, BLOCKS)).toEqual({ templates: [], blocks: [] });
    expect(() => parseOnly("spec", TEMPLATES, BLOCKS)).toThrow(/unknown spec/);
    const f = parseOnly("department-mall,listing", TEMPLATES, BLOCKS);
    expect(selected(f, "department-mall", "listing")).toBe(true);
    expect(selected(f, "department-mall", "card")).toBe(false);
    expect(selected(f, "boutique", "listing")).toBe(false);
  });

  it("runs only the stages a filter needs", () => {
    expect(stagesFor(parseOnly("listing", TEMPLATES, BLOCKS))).toEqual({ matrix: true, variants: false, nav: false, perf: false, hover: false, tiny: false });
    expect(stagesFor(parseOnly("boutique", TEMPLATES, BLOCKS))).toMatchObject({ matrix: true, variants: false, nav: true, perf: true, hover: true, tiny: true });
    expect(stagesFor(parseOnly("", TEMPLATES, BLOCKS))).toEqual({ matrix: true, variants: true, nav: true, perf: true, hover: true, tiny: true });
    expect(stagesFor(parseOnly("size", TEMPLATES, BLOCKS))).toMatchObject({ matrix: true, perf: true, nav: false });
    // The hover-image check needs a preset whose card shows a second photo.
    expect(stagesFor(parseOnly("marketplace", TEMPLATES, BLOCKS)).hover).toBe(false);
  });

  it("fails on any breach unless report-only, and never passes an empty run", () => {
    const checks = [{ template: "a", block: "card", pass: true }, { template: "a", block: "perf", pass: false }];
    expect(summarize(checks)).toMatchObject({ total: 2, passed: 1, failed: 1, byBlock: { card: { pass: 1, fail: 0 }, perf: { pass: 0, fail: 1 } } });
    expect(exitCode(checks)).toBe(1);
    expect(exitCode(checks, { reportOnly: true })).toBe(0);
    expect(exitCode([checks[0]])).toBe(0);
    expect(exitCode([])).toBe(2);
  });

  it("parses ports and refuses duplicates", () => {
    const o = parseArgs(["--only", "boutique", "--report-only", "--api-port", "9011"]);
    expect(o).toMatchObject({ only: "boutique", reportOnly: true, ports: { api: 9011, storefront: 4601, chrome: 9601, apiInspector: 29011 } });
    expect(() => parseArgs(["--api-port", "4601"])).toThrow(/ports must differ/);
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown argument/);
  });

  it("keeps blocked reference captures out of visual pairs and reports them separately from metrics", async () => {
    expect(referenceShotIssue("/shots/target-home-d-top.jpg")).toBe("known blocked reference capture");
    expect(referenceShotIssue("/shots/target-search-m-full.jpg")).toBe("known blocked reference capture");
    expect(referenceShotIssue("/shots/ghorerbazar-home-m-top.jpg")).toBe("known blocked reference capture");
    expect(referenceShotIssue("/shots/target-mega-d.jpg")).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "fidelity-blocked-shots-"));
    try {
      for (const page of ["home", "search", "pdp"]) for (const viewport of ["d", "m"]) {
        writeFileSync(join(dir, `target-${page}-${viewport}-top.jpg`), "blocked capture");
      }
      const pairs = await writePairs({
        reference: { templates: { "marketplace": { refs: { header: "target", card: "target", listing: "target", pdp: "target" } } }, sites: { target: { name: "Target", shots: { home: "target-home", plp: "target-search", pdp: "target-pdp" } } } },
        matrix: {}, checks: [], shotsDir: dir, refDirs: [dir], outDir: join(dir, "pairs"), templates: ["marketplace"],
      });
      expect(pairs.made).toHaveLength(0);
      expect(pairs.unverified).toHaveLength(6);
      expect(pairs.unverified.every((item) => item.reason === "known blocked reference capture")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const visualEvidence = { paired: 2, unverified: [{ template: "marketplace", page: "home", viewport: "desktop", reference: "target-home-d-top.jpg", reason: "known blocked reference capture" }] };
    const report = markdownSummary({ summary: summarize([{ template: "marketplace", block: "header", pass: true }]), checks: [], meta: { finishedAt: "now", git: "test", durationS: 1, peakRssMb: 1 }, filter: "", visualEvidence });
    expect(report).toContain("1/1 metric checks pass");
    expect(report).toContain("Visual pairs: 2 paired, 1 unverified.");
    expect(report).toContain("marketplace/home/desktop | target-home-d-top.jpg | known blocked reference capture");
  });

  it("keeps compact Chaldal cards separate from the full-action grocery default", () => {
    expect(Object.values(reference.templates["daily-essentials"].refs)).toEqual(Array(5).fill("ghorerbazar"));
    expect(reference.templates["daily-essentials"].visualRefs).toEqual({ home: "chaldal", plp: "omneemart", pdp: "omneemart" });
    expect(reference.sites.chaldal.shots).toEqual({ home: "chaldal-home", plp: "chaldal-popular" });
    expect(reference.sites.omneemart.shots).toEqual({ plp: "omneemart-groceries-plp", pdp: "omneemart-pdp" });
    expect(reference.sites.chaldal.desktop["card.cols"].v).toBe(6);
    expect(compareTemplate("daily-essentials", { desktop: {}, phone: {} }, reference).some((c) => c.refSite === "chaldal")).toBe(false);
    expect(referenceShotIssue("/shots/chaldal-popular-d-top.jpg")).toBe("product images missing from reference capture");
    expect(referenceShotIssue("/shots/chaldal-popular-m-top.jpg")).toBeNull();
  });

  it("keeps Walmart's measured desktop home without promoting blocked listing captures", async () => {
    expect(reference.sites.pickaboo.shots).toEqual({ plp: "pickaboo-plp", pdp: "pickaboo-pdp" });
    expect(reference.sites.walmart.shots).toEqual({ home: "walmart-home" });
    expect(reference.sites.walmart.desktop["header.h"].v).toBe(132);
    expect(reference.sites.walmart.phone).toEqual({});
    expect(referenceShotIssue("/shots/walmart-home-d-top.jpg")).toBeNull();
    expect(referenceShotIssue("/shots/walmart-search-m-full.jpg")).toBe("known blocked reference capture");
    // Judged like-for-like: a 173px phone card against Pickaboo's 163px is within the size tolerance.
    expect(reference.sites["target-pickaboo-card"].phone["card.w"].v).toBe(Math.round(157 * 390 / 375));
    expect(judge("size", 173, 163).pass).toBe(true);
    expect(reference.sites.target.phone).toMatchObject({ "card.w": { v: 334 }, "card.cols": { v: 1 } });
  });

  it("uses the accessible Graza collection captures for showcase visual pairs", async () => {
    expect(reference.templates["showcase-landing"].visualRefs).toEqual({ plp: "graza" });
    const dir = mkdtempSync(join(tmpdir(), "fidelity-graza-plp-"));
    try {
      const sharp = await loadSharp();
      const photo = await sharp({ create: { width: 32, height: 20, channels: 3, background: "white" } }).png().toBuffer();
      for (const viewport of ["d", "m"]) {
        writeFileSync(join(dir, `graza-plp-${viewport}-full.png`), photo);
        writeFileSync(join(dir, `ours-showcase-landing-plp-${viewport}-top.jpg`), await sharp(photo).jpeg().toBuffer());
      }
      const pairs = await writePairs({ reference, matrix: {}, checks: [], shotsDir: dir, refDirs: [dir], outDir: join(dir, "pairs"), templates: ["showcase-landing"] });
      expect(pairs.made.map((file) => basename(file))).toEqual(["showcase-landing-plp-d.jpg", "showcase-landing-plp-m.jpg"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("media server paths", () => {
  it("maps R2 object keys onto the pool and refuses anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "fidelity-pool-test-"));
    try {
      mkdirSync(join(dir, "p000.jpg"));
      writeFileSync(join(dir, "p000.jpg", "320.webp"), "x");
      writeFileSync(join(dir, "p000.jpg.orig"), "x");
      writeFileSync(join(dir, "video1.mp4"), "x");
      expect(poolFile(dir, "/media/pool/p000.jpg/320.webp")).toEqual({ file: join(dir, "p000.jpg", "320.webp"), type: "image/webp" });
      expect(poolFile(dir, "/media/pool/p000.jpg")).toEqual({ file: join(dir, "p000.jpg.orig"), type: "image/jpeg" });
      expect(poolFile(dir, "/media/legacy/p000.jpg")?.type).toBe("image/jpeg");
      expect(poolFile(dir, "/media/pool/video1.mp4")?.type).toBe("video/mp4");
      expect(poolFile(dir, "/media/pool/p000.jpg/640.webp")).toBeNull();
      expect(poolFile(dir, "/media/pool/../secrets.env")).toBeNull();
      expect(poolFile(dir, "/api/v1/media/pool/p000.jpg")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reference-metrics.json", () => {
  it("maps every template to measured sites and uses only known metrics", () => {
    expect(Object.keys(reference.templates).sort()).toEqual([...TEMPLATES].sort());
    for (const tpl of Object.values(reference.templates)) {
      for (const site of Object.values(tpl.refs)) expect(reference.sites[site], site).toBeDefined();
    }
    for (const [name, site] of Object.entries(reference.sites)) {
      for (const viewport of ["desktop", "phone"]) {
        for (const [metric, value] of Object.entries(site[viewport] ?? {})) {
          expect(METRIC_RULES[metric], `${name} ${metric}`).toBeDefined();
          expect(typeof value.src, `${name} ${metric} source`).toBe("string");
          if (METRIC_RULES[metric] === "font") expect(parseFont(value.v), `${name} ${metric}`).not.toBeNull();
          else expect(typeof value.v, `${name} ${metric}`).toBe("number");
        }
      }
    }
  });

  it("carries the audit's live density and facet numbers and the §8 tolerances", () => {
    expect(reference.sites.startech.desktop["listing.filtersVisible"].v).toBe(7);
    expect(reference.sites.daraz.desktop["listing.filtersVisible"].v).toBe(21);
    expect(reference.sites.amazon_uk.desktop["listing.filtersVisible"].v).toBe(25);
    expect(reference.sites.daraz.desktop["listing.filterRowPitch"].v).toBe(18);
    expect(reference.sites.startech.desktop["listing.bottomOf20"].v).toBe(3742);
    expect({ ...DEFAULT_TOLERANCES, ...reference.tolerances }).toEqual(DEFAULT_TOLERANCES);
    expect(reference.budgets).toMatchObject({ ttfbHitMs: 50, ttfbMissMs: 300, lcpPhoneMs: 1500, lcpDesktopMs: 1200, cls: 0.05, pdpHtmlKB: 120, categoryHtmlKB: 150, headerHtmlKB: 45, jsonLdKB: 20 });
  });
});
