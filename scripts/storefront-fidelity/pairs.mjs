// Side-by-side pairs (AUDIT appendix): the reference site's first screen next
// to ours for every template x {home, plp, pdp} x {d, m}, labelled with the
// measured numbers and the template's check count. Reference screenshots come
// from the (gitignored) storefront-study and fidelity audit folders.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadSharp } from "./lib/context.mjs";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function findRef(dirs, base, v) {
  for (const dir of dirs) {
    for (const name of [`${base}-${v}-top.jpg`, `${base}-${v}.jpg`, `${base.replace("_", "-")}-${v}.jpg`]) {
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
 * @returns list of written pair files
 */
export async function writePairs({ reference, matrix, checks, shotsDir, refDirs, outDir, templates }) {
  const sharp = await loadSharp();
  mkdirSync(outDir, { recursive: true });
  const made = [];
  const missing = [];
  for (const template of templates) {
    const tpl = reference.templates[template];
    const counts = checks.filter((c) => c.template === template);
    for (const page of ["home", "plp", "pdp"]) {
      const block = page === "plp" ? "listing" : page === "pdp" ? "pdp" : "header";
      const siteKey = page === "plp" ? tpl.refs.listing : tpl.refs.card;
      const site = reference.sites[siteKey];
      const base = site?.shots?.[page];
      for (const v of ["d", "m"]) {
        const viewport = v === "d" ? "desktop" : "phone";
        const ours = join(shotsDir, `ours-${template}-${page}-${v}-top.jpg`);
        const ref = base ? findRef(refDirs, base, v) : null;
        if (!ref || !existsSync(ours)) {
          missing.push(`${template}-${page}-${v}`);
          continue;
        }
        const H = v === "d" ? 900 : 1000;
        const vw = v === "d" ? 1440 : 390;
        const [a, b] = [await firstScreen(sharp, ref, H, vw), await firstScreen(sharp, ours, H, vw)];
        const blockChecks = counts.filter((c) => c.block === block && c.viewport === viewport);
        const failed = blockChecks.filter((c) => !c.pass).length;
        const probe = matrix?.[template]?.[`${page}-${viewport}`];
        const lines = [
          { text: `REFERENCE ${site.name} (${viewport})`, color: "#c80000" },
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
  return { made, missing };
}
