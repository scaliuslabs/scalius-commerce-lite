#!/usr/bin/env node
// Deterministic media pool for the fidelity store, generated with sharp (and
// ffmpeg for the two videos) into the state the harness owns and served by
// lib/media-server.mjs under the same object keys R2 would use:
//   - 240 product photos: square 2400px studio shots (60%), 3:4 1800x2400
//     lifestyle shots (30%) and 4:3 2400x1800 shots (10%), each with the real
//     rendition ladder (packages/shared/src/media-variants.ts) beside the JPEG
//     original, exactly like an upload;
//   - 3 "legacy" originals with no renditions (media/legacy/...);
//   - 5 hero banners (3 wide, 2 square) and a video poster;
//   - a 20 s 720p H.264 video and a ~27 MB raw upload (no poster, no faststart).
// Studio photos compress 3-5x better than real photos, so image bytes are
// understated (AUDIT §1 limits).
//
//   node scripts/storefront-fidelity/pool.mjs --out <dir>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSharp } from "./lib/context.mjs";

export const POOL_SIZE = 240;
export const LEGACY_POOL_INDEXES = [6, 16, 26];
const WIDTHS = [144, 172, 206, 247, 296, 355, 426, 511, 613, 735, 882, 960, 1600];
const MAX = 2400;
const PALETTES = [[20, 20, 24], [200, 30, 40], [30, 90, 200], [240, 240, 240], [60, 160, 90], [230, 150, 30], [120, 60, 160], [180, 180, 190], [15, 60, 90], [250, 200, 210]];
const KINDS = ["phone", "laptop", "headphone", "watch", "shoe", "bag", "bottle", "box"];

const rgb = (c) => `rgb(${c.map((v) => Math.max(0, Math.min(255, Math.round(v)))).join(",")})`;
const shade = (c, d) => c.map((v) => v + d);

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function ladder(width) {
  const master = Math.min(width, MAX);
  return [...WIDTHS.filter((w) => w < master), master];
}

function studioSvg(w, h, kind, col) {
  const lo = rgb(shade(col, -50));
  const hi = rgb(shade(col, 70));
  const c = rgb(col);
  const shapes = {
    phone: `<rect x="${w * .34}" y="${h * .1}" width="${w * .32}" height="${h * .72}" rx="${w / 18}" fill="${lo}"/><rect x="${w * .355}" y="${h * .12}" width="${w * .29}" height="${h * .68}" rx="${w / 22}" fill="#12161e"/><rect x="${w * .365}" y="${h * .13}" width="${w * .27}" height="${h * .66}" rx="${w / 26}" fill="url(#scr)"/>`,
    laptop: `<rect x="${w * .2}" y="${h * .22}" width="${w * .6}" height="${h * .44}" rx="${w / 60}" fill="${lo}"/><rect x="${w * .22}" y="${h * .24}" width="${w * .56}" height="${h * .4}" fill="url(#scr)"/><polygon points="${w * .12},${h * .7} ${w * .88},${h * .7} ${w * .8},${h * .66} ${w * .2},${h * .66}" fill="${hi}"/><rect x="${w * .12}" y="${h * .7}" width="${w * .76}" height="${h * .02}" fill="${lo}"/>`,
    headphone: `<path d="M ${w * .27} ${h * .55} A ${w * .23} ${h * .27} 0 0 1 ${w * .73} ${h * .55}" stroke="${lo}" stroke-width="${w / 22}" fill="none"/><rect x="${w * .2}" y="${h * .42}" width="${w * .16}" height="${h * .3}" rx="${w / 20}" fill="${c}"/><rect x="${w * .64}" y="${h * .42}" width="${w * .16}" height="${h * .3}" rx="${w / 20}" fill="${c}"/>`,
    watch: `<rect x="${w * .42}" y="${h * .08}" width="${w * .16}" height="${h * .78}" fill="${lo}"/><rect x="${w * .33}" y="${h * .3}" width="${w * .34}" height="${h * .34}" rx="${w / 14}" fill="#19191c"/><rect x="${w * .355}" y="${h * .325}" width="${w * .29}" height="${h * .29}" rx="${w / 18}" fill="${c}"/>`,
    shoe: `<path d="M ${w * .12} ${h * .6} Q ${w * .5} ${h * .25} ${w * .88} ${h * .6} Z" fill="${c}"/><rect x="${w * .12}" y="${h * .6}" width="${w * .76}" height="${h * .1}" fill="#f5f5f5"/><ellipse cx="${w * .675}" cy="${h * .425}" rx="${w * .125}" ry="${h * .125}" fill="${c}"/>`,
    bag: `<path d="M ${w * .36} ${h * .32} A ${w * .14} ${h * .18} 0 0 1 ${w * .64} ${h * .32}" stroke="${lo}" stroke-width="${w / 40}" fill="none"/><rect x="${w * .22}" y="${h * .3}" width="${w * .56}" height="${h * .5}" rx="${w / 30}" fill="${c}"/>`,
    bottle: `<rect x="${w * .4}" y="${h * .1}" width="${w * .2}" height="${h * .1}" rx="8" fill="${lo}"/><rect x="${w * .33}" y="${h * .2}" width="${w * .34}" height="${h * .64}" rx="${w / 12}" fill="${c}"/><rect x="${w * .33}" y="${h * .42}" width="${w * .34}" height="${h * .18}" fill="#faf8f0"/>`,
    box: `<rect x="${w * .25}" y="${h * .25}" width="${w * .5}" height="${h * .55}" rx="${w / 40}" fill="${c}"/><rect x="${w * .25}" y="${h * .25}" width="${w * .5}" height="${h * .1}" fill="${hi}"/>`,
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fcfcfc"/><stop offset="1" stop-color="#e8e8ec"/></linearGradient>
<linearGradient id="scr" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#285ac8"/><stop offset="1" stop-color="#c83c8c"/></linearGradient>
<radialGradient id="sh"><stop offset="0" stop-color="#50505a" stop-opacity=".45"/><stop offset="1" stop-color="#50505a" stop-opacity="0"/></radialGradient></defs>
<rect width="100%" height="100%" fill="url(#bg)"/><ellipse cx="${w / 2}" cy="${h * .83}" rx="${w * .32}" ry="${h * .06}" fill="url(#sh)"/>${shapes[kind]}</svg>`;
}

function lifestyleSvg(w, h, col, r) {
  const bases = [[214, 196, 176], [180, 200, 210], [230, 215, 200], [160, 150, 140], [200, 210, 190]];
  const c1 = bases[Math.floor(r() * bases.length)];
  const lines = Array.from({ length: 40 }, (_, i) => {
    const y = h * (0.32 + i * 0.015);
    const cc = col.map((v) => v + Math.round((r() - 0.5) * 50));
    return `<line x1="${w * .3}" y1="${y}" x2="${w * .72}" y2="${y + h * .01}" stroke="${rgb(cc)}" stroke-width="3"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${rgb(c1)}"/><stop offset="1" stop-color="${rgb(shade(c1, -60))}"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#bg)"/><rect y="${h * .82}" width="${w}" height="${h * .18}" fill="${rgb(shade(c1, -80))}"/>
<ellipse cx="${w * .5}" cy="${h * .15}" rx="${w * .08}" ry="${h * .07}" fill="rgb(150,105,80)"/><rect x="${w * .46}" y="${h * .22}" width="${w * .08}" height="${h * .08}" fill="rgb(140,98,75)"/>
<polygon points="${w * .3},${h * .3} ${w * .7},${h * .3} ${w * .78},${h * .95} ${w * .22},${h * .95}" fill="${rgb(col)}"/>${lines}</svg>`;
}

function heroSvg(w, h, c1, c2) {
  const rings = Array.from({ length: 6 }, (_, i) => `<circle cx="${w * .62}" cy="${h * .5}" r="${h * (0.15 + 0.08 * i)}" stroke="#fff" stroke-width="${Math.max(2, Math.round(w / 400))}" fill="none"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${rgb(c1)}"/><stop offset="1" stop-color="${rgb(c2)}"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#bg)"/>${rings}
<rect x="${w * .06}" y="${h * .3}" width="${w * .36}" height="${h * .12}" rx="${h / 40}" fill="#fff"/><rect x="${w * .06}" y="${h * .48}" width="${w * .24}" height="${h * .06}" rx="${h / 60}" fill="#e6e6e6"/><rect x="${w * .06}" y="${h * .62}" width="${w * .12}" height="${h * .1}" rx="${h / 20}" fill="rgb(250,200,40)"/></svg>`;
}

async function noiseTile(sharp, amount) {
  const size = 256;
  const r = rng(99 + amount);
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    const v = Math.round(r() * 255);
    buf[i * 4] = v; buf[i * 4 + 1] = v; buf[i * 4 + 2] = v; buf[i * 4 + 3] = Math.round(amount * 2.55);
  }
  return sharp(buf, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

async function writeImage(sharp, noise, svg, w, h, outDir, key) {
  const base = await sharp(Buffer.from(svg)).composite([{ input: noise, tile: true, blend: "over" }]).jpeg({ quality: 92 }).toBuffer();
  const dir = join(outDir, key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(outDir, `${key}.orig`), base);
  for (const vw of ladder(w)) {
    await sharp(base).resize(vw, Math.round((h * vw) / w), { kernel: "lanczos3" })
      .webp({ quality: vw <= 960 ? 75 : 82 }).toFile(join(dir, `${vw}.webp`));
  }
  return { key, w, h, master: Math.min(w, MAX), size: base.length };
}

async function inPool(items, concurrency, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/** Generates the pool into `outDir` (idempotent: reuses a finished pool). */
export async function generatePool(outDir, { log = console.log } = {}) {
  const metaFile = join(outDir, "meta.json");
  if (existsSync(metaFile) && existsSync(join(outDir, "hero-meta.json"))) {
    return { products: JSON.parse(readFileSync(metaFile, "utf8")), heroes: JSON.parse(readFileSync(join(outDir, "hero-meta.json"), "utf8")) };
  }
  mkdirSync(outDir, { recursive: true });
  const sharp = await loadSharp();
  sharp.concurrency(2);
  const studioNoise = await noiseTile(sharp, 1.5);
  const lifeNoise = await noiseTile(sharp, 6);
  const r = rng(7);
  const specs = Array.from({ length: POOL_SIZE }, (_, i) => {
    const k = i % 10;
    if (k < 6) return { i, w: 2400, h: 2400, svg: studioSvg(2400, 2400, KINDS[i % KINDS.length], PALETTES[(i * 3) % PALETTES.length]), noise: studioNoise };
    if (k < 9) return { i, w: 1800, h: 2400, svg: lifestyleSvg(1800, 2400, PALETTES[(i * 7) % PALETTES.length], r), noise: lifeNoise };
    return { i, w: 2400, h: 1800, svg: studioSvg(2400, 1800, KINDS[(i + 3) % KINDS.length], PALETTES[(i * 5) % PALETTES.length]), noise: studioNoise };
  });
  const started = Date.now();
  const products = await inPool(specs, 3, async (s) => {
    const m = await writeImage(sharp, s.noise, s.svg, s.w, s.h, outDir, `p${String(s.i).padStart(3, "0")}.jpg`);
    if ((s.i + 1) % 60 === 0) log(`  pool ${s.i + 1}/${POOL_SIZE} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    return m;
  });
  const heroSpecs = [
    ["h000.jpg", 2400, 920, [18, 32, 70], [40, 120, 220]],
    ["h001.jpg", 2400, 920, [120, 20, 40], [240, 120, 60]],
    ["h002.jpg", 2400, 920, [20, 70, 50], [120, 200, 140]],
    ["h003.jpg", 1080, 1080, [60, 20, 90], [220, 100, 180]],
    ["h004.jpg", 1080, 1080, [10, 40, 60], [60, 180, 200]],
    ["v000.jpg", 1280, 720, [20, 20, 20], [90, 90, 110]],
  ];
  const heroes = [];
  for (const [key, w, h, c1, c2] of heroSpecs) heroes.push(await writeImage(sharp, studioNoise, heroSvg(w, h, c1, c2), w, h, outDir, key));
  writeFileSync(join(outDir, "hero-meta.json"), JSON.stringify(heroes));
  writeFileSync(metaFile, JSON.stringify(products));
  generateVideos(outDir, log);
  return { products, heroes };
}

/** Two videos when ffmpeg exists: a 20 s faststart clip and a ~27 MB raw upload. */
export function generateVideos(outDir, log = console.log) {
  const v1 = join(outDir, "video1.mp4");
  const v2 = join(outDir, "video2-noposter-big.mp4");
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    log("  ffmpeg not found: the video products are skipped");
    return false;
  }
  if (!existsSync(v1)) {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "20",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-b:v", "2500k", "-movflags", "+faststart", v1]);
  }
  if (!existsSync(v2)) {
    // High bitrate, portrait, no faststart: the moov atom sits at the end, as in a raw phone upload.
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1080x1350:rate=30", "-f", "lavfi", "-i", "anoisesrc=d=30:a=0.05",
      "-t", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-b:v", "7000k", "-c:a", "aac", v2]);
  }
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
  const out = arg("--out");
  if (!out) {
    console.error("Usage: node scripts/storefront-fidelity/pool.mjs --out <dir>");
    process.exit(1);
  }
  const pool = await generatePool(out);
  console.log(`pool: ${pool.products.length} products, ${pool.heroes.length} heroes in ${out}`);
}
