// Side-by-side pairs (AUDIT appendix): the reference site's first screen next
// to ours for every template x {home, plp, pdp} x {d, m}, labelled with the
// measured numbers and the template's check count. Reference screenshots come
// from the (gitignored) storefront-study and fidelity audit folders.
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { loadSharp } from "./lib/context.mjs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// These saved captures show an access challenge, not a storefront. Keep them
// out of visual pairs until each site can be captured and reviewed again.
const BLOCKED_REFERENCE_SHOTS = new Set([
  ...["home", "search", "pdp"].flatMap((page) => ["d", "m"].flatMap((viewport) => ["top", "full"].map((crop) => `target-${page}-${viewport}-${crop}.jpg`))),
  ...["plp-d", "search-d", "search-m"].flatMap((page) => ["top", "full"].map((crop) => `walmart-${page}-${crop}.jpg`)),
  "ghorerbazar-home-m-top.jpg",
  "ghorerbazar-home-m-full.jpg",
]);
// The desktop Popular capture has text and actions but none of its product images.
const INCOMPLETE_REFERENCE_SHOTS = new Set(["chaldal-popular-d-top.jpg", "chaldal-popular-d-full.jpg"]);

export function referenceShotIssue(ref) {
  if (!ref) return "reference screenshot missing";
  const name = basename(ref);
  if (BLOCKED_REFERENCE_SHOTS.has(name)) return "known blocked reference capture";
  if (INCOMPLETE_REFERENCE_SHOTS.has(name)) return "product images missing from reference capture";
  return null;
}

function findRef(dirs, base, v) {
  for (const dir of dirs) {
    for (const name of [`${base}-${v}-top.jpg`, `${base}-${v}.jpg`, `${base}-${v}-full.png`, `${base.replace("_", "-")}-${v}.jpg`]) {
      const f = join(dir, name);
      if (existsSync(f)) return f;
    }
  }
  return null;
}

async function firstScreen(sharp, file, height, viewportWidth) {
  const img = sharp(file);
  const meta = await img.metadata();
  const screenH = Math.round((meta.width * (viewportWidth === 390 ? 844 : 900)) / viewportWidth);
  const crop = meta.height > screenH ? img.extract({ left: 0, top: 0, width: meta.width, height: screenH }) : img;
  const buf = await crop.toBuffer();
  const m2 = await sharp(buf).metadata();
  return sharp(buf).resize(Math.round((m2.width * height) / m2.height), height).toBuffer({ resolveWithObject: true });
}

function label(width, lines) {
  const rows = lines.map((l, i) => `<text x="8" y="${24 + i * 26}" font-family="Arial, Helvetica, sans-serif" font-size="${i % 2 ? 17 : 21}" font-weight="${i % 2 ? 400 : 700}" fill="${l.color}">${esc(l.text)}</text>`).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${lines.length * 26 + 12}">${rows}</svg>`);
}

const fmt = (d) => (d ? `first card y ${d.firstCardTop ?? "-"} | cards >=50% visible ${d.productsFullyHalfVisible ?? "-"} | filters visible ${d.filterControlsVisible ?? "-"} | 20th bottom ${d.bottomOf20 ?? "-"}` : "");
const refFmt = (m) => (m ? `first card y ${m["listing.firstCardY"]?.v ?? "-"} | cards >=50% visible ${m["listing.productsVisible"]?.v ?? "-"} | filters visible ${m["listing.filtersVisible"]?.v ?? "-"} | 20th bottom ${m["listing.bottomOf20"]?.v ?? "-"}` : "");

/**
 * @returns written pairs and screenshots without usable visual evidence
 */
export async function writePairs({ reference, matrix, checks, shotsDir, refDirs, outDir, templates }) {
  const sharp = await loadSharp();
  mkdirSync(outDir, { recursive: true });
  const made = [];
  const unverified = [];
  for (const template of templates) {
    const tpl = reference.templates[template];
    const counts = checks.filter((c) => c.template === template);
    for (const page of ["home", "plp", "pdp"]) {
      const block = page === "plp" ? "listing" : page === "pdp" ? "pdp" : "header";
      const defaultSiteKey = page === "plp" ? tpl.refs.listing : page === "pdp" ? tpl.refs.pdp : tpl.refs.header;
      for (const v of ["d", "m"]) {
        const viewport = v === "d" ? "desktop" : "phone";
        const visualRef = tpl.visualRefs?.[page];
        const siteKey = (typeof visualRef === "string" ? visualRef : visualRef?.[viewport]) ?? defaultSiteKey;
        const site = reference.sites[siteKey];
        const base = site?.shots?.[page];
        const oursPage = template === "marketplace" && page === "plp" ? "search" : page;
        const ours = join(shotsDir, `ours-${template}-${oursPage}-${v}-top.jpg`);
        const ref = base ? findRef(refDirs, base, v) : null;
        const issue = referenceShotIssue(ref) ?? (!existsSync(ours) ? "our screenshot missing" : null);
        if (issue) {
          unverified.push({ template, page, viewport, reference: ref ? basename(ref) : null, reason: issue });
          continue;
        }
        const H = v === "d" ? 900 : 1000;
        const vw = v === "d" ? 1440 : 390;
        const [a, b] = [await firstScreen(sharp, ref, H, vw), await firstScreen(sharp, ours, H, vw)];
        const blockChecks = counts.filter((c) => c.block === block && c.viewport === viewport && !c.metric.startsWith("listing.search"));
        const failed = blockChecks.filter((c) => !c.pass).length;
        const probe = matrix?.[template]?.[`${oursPage}-${viewport}`];
        const lines = [
          { text: `REFERENCE ${site.name} (${viewport}${siteKey !== defaultSiteKey ? ", alternate visual" : ""})`, color: "#c80000" },
          { text: page === "plp" ? refFmt(site[viewport]) : "", color: "#c80000" },
        ];
        const oursLines = [
          { text: `OURS ${template} ${page} (${viewport}) - ${block}: ${blockChecks.length - failed}/${blockChecks.length} checks pass`, color: "#0050c8" },
          { text: page === "plp" ? fmt(probe?.density) : "", color: "#0050c8" },
        ];
        const labelH = 64;
        const width = a.info.width + b.info.width + 24;
        const canvas = sharp({ create: { width, height: H + labelH, channels: 3, background: "#ffffff" } }).composite([
          { input: a.data, left: 0, top: labelH },
          { input: b.data, left: a.info.width + 24, top: labelH },
          { input: label(a.info.width, lines), left: 0, top: 0 },
          { input: label(b.info.width, oursLines), left: a.info.width + 24, top: 0 },
        ]);
        const scale = v === "d" ? 0.5 : 0.6;
        const flat = await canvas.jpeg().toBuffer();
        const file = join(outDir, `${template}-${page}-${v}.jpg`);
        await sharp(flat).resize(Math.round(width * scale)).jpeg({ quality: 72 }).toFile(file);
        made.push(file);
      }
    }
  }
  return { made, unverified };
}
