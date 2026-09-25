import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { poolFile } from "./lib/media-server.mjs";
import {
  DEFAULT_TOLERANCES, METRIC_RULES, compareTemplate, exitCode, extractOurs, htmlBudgetKb, judge, median, navChecks,
  parseFont, parseOnly, perfChecks, pixelDiffPct, selected, summarize, variantChecks,
} from "./lib/compare.mjs";
import { TEMPLATES } from "./lib/context.mjs";
import { BLOCKS, parseArgs, stagesFor } from "./check.mjs";
import { differingTraits, paddedDiffPct } from "./variants.mjs";

const reference = JSON.parse(readFileSync(new URL("./reference-metrics.json", import.meta.url), "utf8"));

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
const pdpProbe = { h1: { font: "30/600" }, pdp: { price: "30/600", buttons: [{ text: "Add to cart", w: 290, h: 44 }], buyTop: 520 } };

describe("our metrics from probe results", () => {
  it("maps the probe onto the reference metric keys", () => {
    const ours = extractOurs({ home: probe(), plp: plpProbe, pdp: pdpProbe });
    expect(ours).toMatchObject({
      "header.h": 134, "header.search.w": 679, "card.w": 213, "card.h": 333, "card.cols": 4, "card.gap": 10, "card.ratio": 1,
      "card.title": "14/600", "listing.firstCardY": 441, "listing.filtersVisible": 2, "listing.bottomOf20": 2146,
      "listing.filterColumnW": 236, "listing.filterRowPitch": 44, "pdp.h1": "30/600", "pdp.cta.w": 290, "pdp.buyTop": 520, "footer.h": 1215,
    });
    for (const key of Object.keys(METRIC_RULES)) expect(key in ours).toBe(true);
  });

  it("reports missing elements as null, and a one-column list as gap 0", () => {
    const ours = extractOurs({ home: { headerRows: [] }, plp: { density: { cols: 1 }, card: { w: 358 } }, pdp: {} });
    expect(ours["header.h"]).toBeNull();
    expect(ours["header.search.w"]).toBeNull();
    expect(ours["card.gap"]).toBe(0);
    expect(ours["pdp.h1"]).toBeNull();
    expect(extractOurs()["card.w"]).toBeNull();
  });
});

describe("template comparison", () => {
  const ours = { desktop: extractOurs({ home: probe(), plp: plpProbe, pdp: pdpProbe }), phone: {} };

  it("checks every metric of the mapped reference site, per block", () => {
    const checks = compareTemplate("spec-catalogue", ours, reference);
    const byMetric = Object.fromEntries(checks.filter((c) => c.viewport === "desktop").map((c) => [c.metric, c]));
    expect(byMetric["card.h"]).toMatchObject({ ours: 333, ref: 665, refSite: "startech", pass: false, block: "card" });
    expect(byMetric["header.h"].pass).toBe(true);
    expect(byMetric["listing.filtersVisible"]).toMatchObject({ ours: 2, ref: 7, pass: false });
    expect(byMetric["footer.h"]).toMatchObject({ ours: 1215, ref: 448, pass: false });
    expect(byMetric["pdp.buyTop"]).toMatchObject({ ref: 400, pass: false });
    expect(checks.every((c) => c.id === `${c.template}/${c.block}/${c.viewport}/${c.metric}`)).toBe(true);
    // phone metrics exist in the reference but nothing was measured: every one fails as missing
    expect(checks.filter((c) => c.viewport === "phone").every((c) => !c.pass)).toBe(true);
  });

  it("judges filters visible only on large-catalogue templates", () => {
    const small = { ...reference, templates: { ...reference.templates, "spec-catalogue": { ...reference.templates["spec-catalogue"], largeCatalogue: false } } };
    expect(compareTemplate("spec-catalogue", ours, small).some((c) => c.metric === "listing.filtersVisible")).toBe(false);
  });

  it("uses a different reference per block (marketplace: Amazon header, Daraz cards)", () => {
    const checks = compareTemplate("marketplace", ours, reference);
    expect(checks.find((c) => c.metric === "header.h" && c.viewport === "desktop").refSite).toBe("amazon");
    expect(checks.find((c) => c.metric === "card.w" && c.viewport === "desktop").refSite).toBe("daraz");
  });

  it("refuses an unmapped template", () => {
    expect(() => compareTemplate("nope", ours, reference)).toThrow(/no reference mapping/);
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

  it("wants card variants at least 25% apart", () => {
    const checks = variantChecks("department-mall", [{ a: "retail", b: "quick-add", pct: 0, viewport: "desktop" }, { a: "spec", b: "standard", pct: 31.4, viewport: "phone" }], reference.budgets);
    expect(checks.map((c) => c.pass)).toEqual([false, true]);
    expect(checks[0].id).toBe("department-mall/variants/desktop/card.retail~quick-add.diffPct");
  });

  it("wants every pair three treatments apart, card photos at most 1.2x, and plain cards whole", () => {
    const checks = variantChecks("department-mall", [], reference.budgets, {
      structural: [{ a: "standard", b: "boutique", count: 2, differing: ["ratio", "tile"], viewport: "desktop" }, { a: "spec", b: "retail", count: 7, differing: [], viewport: "phone" }],
      photos: [{ variant: "spec", viewport: "desktop", drawn: 204, fetched: 240, ratio: 1.18 }, { variant: "retail", viewport: "desktop", drawn: 241, fetched: 320, ratio: 1.33 }, { variant: "retail", viewport: "phone", ratio: 2 }],
      plain: { "spec-phone": { box: { w: 180, h: 400 }, empty: false, titleFontPx: 13 }, "retail-desktop": { box: { w: 250, h: 0 }, empty: true, titleFontPx: 14 } },
    });
    const f = (suffix) => checks.find((c) => c.id.endsWith(suffix));
    expect(f("card.standard~boutique.treatments")).toMatchObject({ pass: false, detail: "2 < 3: ratio, tile" });
    expect(f("card.spec~retail.treatments").pass).toBe(true);
    expect(f("desktop/card.spec.photoRatio").pass).toBe(true);
    expect(f("desktop/card.retail.photoRatio").pass).toBe(false);
    expect(checks.some((c) => c.id.endsWith("phone/card.retail.photoRatio"))).toBe(false);
    expect(f("phone/card.spec.titlePx").pass).toBe(false);
    expect(f("phone/card.spec.plainRenders").pass).toBe(true);
    expect(f("desktop/card.retail.plainRenders").pass).toBe(false);
  });

  it("compares cards at their natural size on one white canvas, and names the treatments that differ", () => {
    const tall = { data: Buffer.from([0, 0, 0, 0]), width: 1, height: 4 };
    const short = { data: Buffer.from([0, 0]), width: 1, height: 2 };
    expect(paddedDiffPct(tall, short)).toBe(50);
    expect(differingTraits({ a: "1", b: "x", c: "y" }, { a: "1", b: "z", c: "q" })).toEqual(["b", "c"]);
  });

  it("measures pixel difference as the share of pixels more than 28 grey levels apart", () => {
    const a = Buffer.from([0, 0, 0, 0, 100, 100, 100, 100]);
    const b = Buffer.from([0, 28, 29, 255, 100, 100, 100, 72]);
    expect(pixelDiffPct(a, b)).toBe(25);
    expect(() => pixelDiffPct(a, Buffer.alloc(3))).toThrow();
  });
});

describe("filters, verdict and exit code", () => {
  it("parses --only into templates and blocks and rejects unknown names", () => {
    expect(parseOnly("spec-catalogue,listing", TEMPLATES, BLOCKS)).toEqual({ templates: ["spec-catalogue"], blocks: ["listing"] });
    expect(parseOnly("", TEMPLATES, BLOCKS)).toEqual({ templates: [], blocks: [] });
    expect(() => parseOnly("spec", TEMPLATES, BLOCKS)).toThrow(/unknown spec/);
    const f = parseOnly("spec-catalogue,listing", TEMPLATES, BLOCKS);
    expect(selected(f, "spec-catalogue", "listing")).toBe(true);
    expect(selected(f, "spec-catalogue", "card")).toBe(false);
    expect(selected(f, "boutique", "listing")).toBe(false);
  });

  it("runs only the stages a filter needs", () => {
    expect(stagesFor(parseOnly("listing", TEMPLATES, BLOCKS))).toEqual({ matrix: true, variants: false, nav: false, perf: false, hover: false, tiny: false });
    expect(stagesFor(parseOnly("boutique", TEMPLATES, BLOCKS))).toMatchObject({ matrix: true, variants: false, nav: true, perf: true, hover: true, tiny: true });
    expect(stagesFor(parseOnly("", TEMPLATES, BLOCKS))).toEqual({ matrix: true, variants: true, nav: true, perf: true, hover: true, tiny: true });
    expect(stagesFor(parseOnly("size", TEMPLATES, BLOCKS))).toMatchObject({ matrix: true, perf: true, nav: false });
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
