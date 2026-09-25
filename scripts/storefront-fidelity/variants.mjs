// Distinctness (AUDIT §2.1, §2.2, slice 2b): one template's tokens held
// fixed, ONE block variant swapped at a time (what a merchant does in the
// dashboard). Cards are measured on a product with every commerce signal the
// store can hold (a discount, 10+ sold in 30 days, a colour axis with real
// swatch colours, a published brand, a delivery rate) and on a plain product
// with none, so a card never renders broken when facts are missing.
//
// Two bars per pair of variants:
//   - pixels: each card at its natural size (no stretching), both padded
//     onto one white canvas, the share of pixels more than 28 grey levels
//     apart (>= 25% for the nearest other variant);
//   - structure: the buyer-visible treatments measured in the browser
//     (photo box, tile, price place/size/colour, struck price, discount
//     mark, rating, facts, title, button, Compare); >= 3 differ.
// Plus the card photo's fetched width against its drawn width (<= 1.2x at
// DPR 1). Every listing layout is probed. Run through check.mjs.
import { join } from "node:path";
import { loadSharp } from "./lib/context.mjs";
import { pixelDiffPct } from "./lib/compare.mjs";
import { sleep } from "./lib/proc.mjs";
import { applyTheme, variantNames } from "./lib/theme.mjs";
import { probePage } from "./matrix.mjs";
import { MENUS } from "./menus.mjs";

/**
 * The fixture products from the seeded store: the richest discounted product
 * (10+ sold, a colour axis of two or more values, a published brand, a
 * rendered photo; one price for every option, so the amount saved shows, a
 * discount of 15% or more and key specs preferred) and a plain one (no
 * discount, no options, no sales).
 */
export function pickCardProducts(db) {
  const colourAxis = `EXISTS (SELECT 1 FROM product_option_definitions axis
      WHERE axis.product_id = p.id AND axis.deleted_at IS NULL
        AND (axis.standard_mapping = 'color' OR axis.normalized_name IN ('color', 'colour', 'colours', 'colors'))
        AND (SELECT count(*) FROM product_option_values v WHERE v.option_definition_id = axis.id AND v.deleted_at IS NULL) >= 2)`;
  const renderedPhoto = `EXISTS (SELECT 1 FROM product_media pm JOIN media m ON m.id = pm.media_id
      WHERE pm.product_id = p.id AND pm.is_primary = 1 AND m.kind = 'image' AND m.variant_width IS NOT NULL)`;
  const keySpecs = `(SELECT count(*) FROM product_attribute_values av JOIN product_attributes a ON a.id = av.attribute_id AND a.key_spec = 1 AND a.deleted_at IS NULL WHERE av.product_id = p.id)`;
  const rich = db.prepare(`SELECT p.id, p.slug, p.name, st.sold_30d AS sold, ${keySpecs} AS specs
    FROM products p
    JOIN product_buyer_state s ON s.product_id = p.id AND s.is_public = 1 AND s.has_discount = 1 AND s.available_for_sale = 1
    JOIN product_sales_stats st ON st.product_id = p.id AND st.sold_30d >= 10
    JOIN brands b ON b.id = p.brand_id AND b.status = 'published' AND b.deleted_at IS NULL
    WHERE ${colourAxis} AND ${renderedPhoto}
    ORDER BY (s.from_minor = s.to_minor) DESC, (s.discount_depth_bps >= 1500) DESC, (${keySpecs} >= 4) DESC, st.sold_30d DESC, p.id LIMIT 1`).get();
  const plain = db.prepare(`SELECT p.id, p.slug, p.name FROM products p
    JOIN product_buyer_state s ON s.product_id = p.id AND s.is_public = 1 AND s.has_discount = 0
      AND s.available_for_sale = 1 AND s.has_customer_options = 0
    WHERE NOT EXISTS (SELECT 1 FROM product_sales_stats st WHERE st.product_id = p.id AND st.sold_30d >= 10)
      AND ${renderedPhoto}
    ORDER BY p.id LIMIT 1`).get();
  if (!rich) throw new Error("no product with every card signal in the seeded store");
  return { rich, plain };
}

/** A listing that shows `product`: a search for its exact name. */
export const productListing = (product) => `/search?q=${encodeURIComponent(product.name)}`;

/**
 * In the page: the card linking to `slug`, its row stretched to natural
 * height (grids stretch every card to the tallest in its row), its box, the
 * photo's fetched and drawn widths, and its buyer-visible treatments.
 */
const CARD_PROBE = (slug) => `(async () => {
  const link = document.querySelector('[data-theme-component="product-card"] a.product-card-link[href="/products/${slug}"]');
  const card = link && link.closest('[data-theme-component="product-card"]');
  if (!card) return null;
  card.parentElement.style.alignItems = 'start';
  card.style.height = 'auto';
  card.scrollIntoView({ block: 'center' });
  const img = card.querySelector('img.product-card-photo');
  if (img && !(img.complete && img.naturalWidth)) await new Promise((r) => { img.onload = img.onerror = r; setTimeout(r, 4000); });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const box = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + scrollX, y: b.y + scrollY, w: b.width, h: b.height, top: b.top }; };
  const cs = (el) => el ? getComputedStyle(el) : null;
  const body = card.querySelector('.product-card-body');
  const title = link.parentElement;
  const price = card.querySelector('.pc-price-whole') || card.querySelector('.product-card-price') || body.querySelector('p.mt-auto > span:last-child');
  const regular = card.querySelector('.pc-price-regular') || card.querySelector('s');
  const media = card.querySelector('.product-card-media');
  const marks = [...card.querySelectorAll('[data-card-discount]')].map((m) => { const s = cs(m); return [m.closest('.product-card-media') ? 'photo' : 'price', m.textContent.trim(), s.backgroundColor, s.color, s.borderRadius].join('/'); });
  const action = [...card.querySelectorAll('a[href^="/buy/"], [data-card-action-hint], .product-card-round-action')][0];
  const as = cs(action);
  const rating = card.querySelector('[data-card-fact="rating"]');
  const c = cs(card);
  const lines = (el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
  const drawn = img ? img.clientWidth - parseFloat(cs(img).paddingLeft) - parseFloat(cs(img).paddingRight) : 0;
  const fetched = img ? (Number((/\\/(\\d+)\\.webp(?:[?#].*)?$/.exec(img.currentSrc) || [])[1]) || img.naturalWidth) : 0;
  const b = box(card);
  return {
    box: b,
    photo: img ? { drawn: Math.round(drawn), fetched, ratio: drawn ? Math.round((fetched / (drawn * devicePixelRatio)) * 100) / 100 : null } : null,
    traits: {
      ratio: media ? (media.clientWidth / media.clientHeight).toFixed(2) : 'none',
      fit: img ? cs(img).objectFit + '/' + Math.round(parseFloat(cs(img).paddingLeft)) : 'none',
      tile: [c.backgroundColor, c.borderTopWidth, c.boxShadow === 'none' ? 'flat' : 'shadow', c.borderTopLeftRadius].join('/'),
      pricePlace: box(price).top < box(title).top ? 'before-title' : 'after-title',
      priceSize: cs(price).fontSize + '/' + cs(price).fontWeight,
      priceColour: cs(price).color,
      strike: regular ? [box(regular).top > box(price).top + 4 ? 'below' : box(regular).x < box(price).x ? 'before' : 'after', cs(regular.querySelector('s') || regular).textDecorationLine, regular.textContent.replace(/[\\d৳,.\\s]|Regular price/g, '')].join('/') : 'none',
      discount: marks.sort().join('|') || 'none',
      rating: rating ? (rating.querySelector('.pc-stars') ? 'stars' : 'score') : 'none',
      facts: [...card.querySelectorAll('[data-card-fact]')].map((n) => n.dataset.cardFact).sort().join(',') || 'none',
      title: lines(title) + '/' + cs(title).fontSize + '/' + cs(title).fontWeight,
      button: action ? [as.backgroundColor, as.borderTopWidth, as.borderTopLeftRadius, Math.round(action.getBoundingClientRect().width / b.w * 10)].join('/') : 'none',
      compare: card.querySelector('[data-compare-toggle]') ? 'compare' : 'none',
    },
    titleFontPx: parseFloat(cs(title).fontSize),
    empty: !card.textContent.trim() || !price,
  };
})()`;

async function greyNatural(sharp, file) {
  const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Both crops padded top-left onto one white canvas of the larger size, then compared. */
export function paddedDiffPct(a, b) {
  const W = Math.max(a.width, b.width);
  const H = Math.max(a.height, b.height);
  const pad = (img) => {
    const out = Buffer.alloc(W * H, 255);
    for (let y = 0; y < img.height; y += 1) img.data.copy(out, y * W, y * img.width, y * img.width + img.width);
    return out;
  };
  return pixelDiffPct(pad(a), pad(b));
}

/** Traits that differ between two cards. */
export function differingTraits(a, b) {
  return Object.keys(a).filter((key) => a[key] !== b[key]);
}

/** For each variant: its nearest other variant by pixels, and every pair's pixel and structural difference. */
export async function cardDiffs(cards, viewport) {
  const sharp = await loadSharp();
  const names = Object.keys(cards).filter((n) => cards[n].file);
  const grey = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await greyNatural(sharp, cards[n].file)])));
  const pairs = {};
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const [a, b] = [names[i], names[j]];
      const differing = differingTraits(cards[a].traits, cards[b].traits);
      pairs[`${a}~${b}`] = { pct: paddedDiffPct(grey[a], grey[b]), structural: differing.length, differing };
    }
  }
  const pair = (a, b) => pairs[`${a}~${b}`] ?? pairs[`${b}~${a}`];
  const nearest = names.map((a) => {
    let best = null;
    for (const b of names) {
      if (a === b) continue;
      const pct = pair(a, b).pct;
      if (!best || pct < best.pct) best = { a, b, pct, viewport };
    }
    return best;
  }).filter(Boolean);
  const structural = Object.entries(pairs).map(([key, p]) => {
    const [a, b] = key.split("~");
    return { a, b, count: p.structural, differing: p.differing, viewport };
  });
  return { pairs, nearest, structural };
}

export async function runVariants(ctx, { template = "department-mall", path }) {
  const { page, base, log, shotsDir, db } = ctx;
  const { card: cards, listing: layouts } = await variantNames();
  const fixture = pickCardProducts(db);
  log(`  card fixture: ${fixture.rich.slug} (${fixture.rich.sold} sold, ${fixture.rich.specs} key specs); plain ${fixture.plain?.slug ?? "none"}`);
  const out = { template, fixture, cards: {}, plain: {}, listings: {}, diffs: [], structural: [], photos: [] };
  const measured = { desktop: {}, phone: {} };
  for (const v of cards) {
    await applyTheme(ctx, template, { menu: MENUS["150"], sets: { "blocks.card.variant": v } });
    for (const viewport of ["desktop", "phone"]) {
      await page.profile(viewport);
      const tag = viewport === "phone" ? "m" : "d";
      for (const [role, product] of [["rich", fixture.rich], ["plain", fixture.plain]]) {
        if (!product) continue;
        // An empty cache, so the photo's candidate is the one `sizes` asks
        // for (Chrome reuses a larger cached candidate from another viewport).
        await page.send("Network.clearBrowserCache");
        await page.nav(base + productListing(product), { settle: 600 });
        const m = await page.eval(CARD_PROBE(product.slug));
        if (!m) {
          log(`  ${v} ${viewport}: ${role} card not found on ${productListing(product)}`);
          continue;
        }
        await sleep(150);
        const name = `card-${role}-${v}-${tag}`;
        await page.shot(name, { quality: 92, clip: { x: m.box.x, y: m.box.y, width: m.box.w, height: Math.min(m.box.h, 1200) } });
        const record = { ...m, file: join(shotsDir, `${name}.jpg`) };
        if (role === "rich") {
          out.cards[`${v}-${viewport}`] = record;
          measured[viewport][v] = record;
          if (m.photo) out.photos.push({ variant: v, viewport, ...m.photo });
        } else {
          out.plain[`${v}-${viewport}`] = { box: m.box, empty: m.empty, titleFontPx: m.titleFontPx };
        }
      }
    }
  }
  for (const viewport of ["desktop", "phone"]) {
    if (Object.keys(measured[viewport]).length < 2) continue;
    const { pairs, nearest, structural } = await cardDiffs(measured[viewport], viewport);
    out[`pairs-${viewport}`] = pairs;
    out.diffs.push(...nearest);
    out.structural.push(...structural);
  }
  const weakest = [...out.diffs].filter((d) => d.viewport === "desktop").sort((x, y) => x.pct - y.pct).slice(0, 4);
  log(`  variants ${template} cards (nearest by pixels, desktop): ${weakest.map((d) => `${d.a}~${d.b} ${d.pct}%`).join(", ")}`);
  const fewest = [...out.structural].sort((x, y) => x.count - y.count).slice(0, 3);
  log(`  variants ${template} cards (fewest differing treatments): ${fewest.map((d) => `${d.a}~${d.b} ${d.count} (${d.viewport})`).join(", ")}`);
  for (const v of layouts) {
    await applyTheme(ctx, template, { menu: MENUS["150"], sets: { "blocks.listing.layout.variant": v } });
    for (const viewport of ["desktop", "phone"]) {
      await page.profile(viewport);
      const m = await probePage(page, base + path);
      // No markup names the rendered layout, so describe what is on screen:
      // a visible filter sidebar, a filter bar, the grid's columns, shelves.
      const layout = [
        m.listing?.filterBox ? "sidebar" : null,
        m.listing?.phoneBar ? "filter-bar" : null,
        await page.eval("(() => { const b = document.querySelector('[data-catalog-filter-bar]'); const r = b && b.getBoundingClientRect(); return r && r.width > 0 && r.height > 0 ? 'chip-bar' : null; })()"),
        m.density?.cols ? `${m.density.cols}-col` : null,
      ].filter(Boolean).join("+") || "none";
      out.listings[`${v}-${viewport}`] = { layout, listing: m.listing ?? null, density: m.density ?? null, card: m.card ? { w: m.card.w, h: m.card.h, cols: m.card.cols } : null };
      await page.shot(`listing-${template}-${v}-${viewport === "phone" ? "m" : "d"}`);
    }
  }
  log(`  variants ${template} listings: ${layouts.map((v) => `${v}->${out.listings[`${v}-desktop`]?.layout ?? "?"}`).join(", ")}`);
  return out;
}
