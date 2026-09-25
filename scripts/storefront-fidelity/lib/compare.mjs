// Pure comparison and tolerance logic of the fidelity check (unit-tested in
// compare.test.mjs). Measurements in, a flat list of checks out; each check
// passes or fails against the AUDIT.md §8 global bar.

/** How each reference metric is judged. */
export const METRIC_RULES = Object.freeze({
  "header.h": "size",
  "header.search.w": "size",
  "header.search.h": "size",
  "card.w": "size",
  "card.h": "size",
  "card.cols": "exact",
  "card.gap": "gap",
  "card.ratio": "ratio",
  "card.title": "font",
  "card.price": "font",
  "listing.firstCardY": "firstY",
  "listing.productsVisible": "min",
  "listing.filtersVisible": "min",
  "listing.bottomOf20": "scroll",
  "listing.filterColumnW": "size",
  "listing.filterRowPitch": "size",
  "pdp.h1": "font",
  "pdp.price": "font",
  "pdp.cta.w": "size",
  "pdp.cta.h": "size",
  "footer.h": "size",
});

export const DEFAULT_TOLERANCES = Object.freeze({
  sizePct: 0.1, sizeMinPx: 2, gapPx: 4, fontPx: 1, fontWeight: 100, ratio: 0.05, scrollFactor: 1.1, firstYSlackPx: 40,
});

export const VIEWPORTS = Object.freeze(["desktop", "phone"]);
const EPS = 1e-6;

export function blockOf(metric) {
  return metric.split(".")[0];
}

/** "17.9584/800" -> { size: 17.9584, weight: 800 }; null when unreadable. */
export function parseFont(value) {
  if (value == null) return null;
  const m = /^\s*([\d.]+)\s*\/\s*(\d+|normal|bold)\s*$/.exec(String(value));
  if (!m) return null;
  const weight = m[2] === "normal" ? 400 : m[2] === "bold" ? 700 : Number(m[2]);
  return { size: Number(m[1]), weight };
}

const round = (v, d = 2) => (typeof v === "number" ? Math.round(v * 10 ** d) / 10 ** d : v);

/**
 * Judges one measurement. Returns { pass, detail }. A missing measurement
 * (null/undefined, the element does not exist on our page) always fails.
 */
export function judge(rule, ours, ref, tol = DEFAULT_TOLERANCES) {
  if (ours === null || ours === undefined || (typeof ours === "number" && !Number.isFinite(ours))) {
    return { pass: false, detail: "missing on our page" };
  }
  switch (rule) {
    case "size": {
      const allowed = Math.max(Math.abs(ref) * tol.sizePct, tol.sizeMinPx);
      const d = ours - ref;
      return { pass: Math.abs(d) <= allowed + EPS, detail: `${d >= 0 ? "+" : ""}${round(d)}px (${ref ? `${d >= 0 ? "+" : ""}${round((d / ref) * 100, 1)}%` : "n/a"}; allowed ±${round(allowed)})` };
    }
    case "gap": {
      const d = ours - ref;
      return { pass: Math.abs(d) <= tol.gapPx + EPS, detail: `${d >= 0 ? "+" : ""}${round(d)}px (allowed ±${tol.gapPx})` };
    }
    case "exact":
      return { pass: ours === ref, detail: ours === ref ? "equal" : `${ours} vs ${ref}` };
    case "ratio": {
      const d = ours - ref;
      return { pass: Math.abs(d) <= tol.ratio + EPS, detail: `${d >= 0 ? "+" : ""}${round(d, 3)} (allowed ±${tol.ratio})` };
    }
    case "font": {
      const o = parseFont(ours);
      const r = parseFont(ref);
      if (!o) return { pass: false, detail: `unreadable font ${ours}` };
      if (!r) return { pass: false, detail: `unreadable reference font ${ref}` };
      const ds = o.size - r.size;
      const dw = o.weight - r.weight;
      const pass = Math.abs(ds) <= tol.fontPx + 0.05 && Math.abs(dw) <= tol.fontWeight;
      return { pass, detail: `size ${ds >= 0 ? "+" : ""}${round(ds)}px (±${tol.fontPx}), weight ${dw >= 0 ? "+" : ""}${dw} (±${tol.fontWeight})` };
    }
    case "min":
      return { pass: ours >= ref, detail: ours >= ref ? `>= ${ref}` : `${ours} < ${ref}` };
    case "scroll": {
      const limit = ref * tol.scrollFactor;
      return { pass: ours <= limit + EPS, detail: `${round(ours / ref, 2)}x the reference (allowed ${tol.scrollFactor}x = ${Math.round(limit)}px)` };
    }
    case "firstY": {
      const limit = ref + tol.firstYSlackPx;
      return { pass: ours <= limit, detail: `${ours - ref >= 0 ? "+" : ""}${ours - ref}px (allowed <= ${limit})` };
    }
    case "max":
      return { pass: ours <= ref + EPS, detail: ours <= ref ? `<= ${ref}` : `${round(ours)} > ${ref}` };
    case "zero":
      return { pass: ours === 0, detail: ours === 0 ? "0" : `${ours} (must be 0)` };
    case "true":
      return { pass: ours === true, detail: ours === true ? "yes" : "no" };
    default:
      throw new Error(`unknown rule ${rule}`);
  }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Our metrics for one template and viewport from the probe results of its
 * home, category (plp) and product (pdp) pages. Keys match METRIC_RULES.
 */
export function extractOurs({ home, plp, pdp } = {}) {
  const out = {};
  const rows = home?.headerRows ?? [];
  out["header.h"] = rows.length ? rows.reduce((n, r) => n + (r.h ?? 0), 0) : num(home?.header?.h) || null;
  out["header.search.w"] = num(home?.search?.w);
  out["header.search.h"] = num(home?.search?.h);
  const card = plp?.card;
  out["card.w"] = num(card?.w) ?? num(plp?.density?.cardW);
  out["card.h"] = num(card?.h) ?? num(plp?.density?.cardH);
  out["card.cols"] = num(plp?.density?.cols) || num(card?.cols);
  out["card.gap"] = num(card?.gap) ?? (out["card.cols"] === 1 ? 0 : null);
  out["card.ratio"] = num(card?.media?.ratio);
  out["card.title"] = card?.title?.font ?? null;
  out["card.price"] = card?.price?.font ?? null;
  const d = plp?.density;
  out["listing.firstCardY"] = num(d?.firstCardTop);
  out["listing.productsVisible"] = num(d?.productsFullyHalfVisible);
  out["listing.filtersVisible"] = num(d?.filterControlsVisible);
  out["listing.bottomOf20"] = num(d?.bottomOf20);
  out["listing.filterColumnW"] = num(plp?.facets?.columnW) ?? num(plp?.listing?.filterBox?.w);
  out["listing.filterRowPitch"] = num(plp?.facets?.rowPitch);
  out["pdp.h1"] = pdp?.h1?.font ?? null;
  out["pdp.price"] = pdp?.pdp?.price ?? null;
  const cta = (pdp?.pdp?.buttons ?? []).find((b) => b.w > 0) ?? null;
  out["pdp.cta.w"] = num(cta?.w);
  out["pdp.cta.h"] = num(cta?.h);
  out["pdp.buyTop"] = num(pdp?.pdp?.buyTop);
  out["footer.h"] = num(home?.footer?.h);
  return out;
}

/**
 * Checks for one template: every reference metric of each block's mapped
 * site, per viewport. `filtersVisible` is judged only on large-catalogue
 * templates (AUDIT §8). The buy box must start within the first 400px at 1440.
 */
export function compareTemplate(template, oursByViewport, reference) {
  const tpl = reference.templates[template];
  if (!tpl) throw new Error(`no reference mapping for template ${template}`);
  const tol = { ...DEFAULT_TOLERANCES, ...(reference.tolerances ?? {}) };
  const checks = [];
  for (const viewport of VIEWPORTS) {
    const ours = oursByViewport[viewport] ?? {};
    for (const [metric, rule] of Object.entries(METRIC_RULES)) {
      const block = blockOf(metric);
      const site = tpl.refs?.[block];
      const ref = site ? reference.sites[site]?.[viewport]?.[metric] : undefined;
      if (!ref) continue;
      if (metric === "listing.filtersVisible" && !tpl.largeCatalogue) continue;
      const { pass, detail } = judge(rule, ours[metric], ref.v, tol);
      checks.push({ id: `${template}/${block}/${viewport}/${metric}`, template, block, viewport, metric, rule, ours: ours[metric] ?? null, ref: ref.v, refSite: site, src: ref.src, pass, detail });
    }
    if (viewport === "desktop" && reference.budgets?.buyBoxTopPx) {
      const { pass, detail } = judge("max", ours["pdp.buyTop"], reference.budgets.buyBoxTopPx, tol);
      checks.push({ id: `${template}/pdp/desktop/pdp.buyTop`, template, block: "pdp", viewport, metric: "pdp.buyTop", rule: "max", ours: ours["pdp.buyTop"] ?? null, ref: reference.budgets.buyBoxTopPx, refSite: "bar", src: "AUDIT §8 slice 5: buy box top <= 400px at 1440x900", pass, detail });
    }
  }
  return checks;
}

export function median(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function budgetCheck(block, template, viewport, metric, value, limit, src, rule = "max") {
  const { pass, detail } = judge(rule, value, limit);
  return { id: `${template}/${block}/${viewport}/${metric}`, template, block, viewport, metric, rule, ours: value ?? null, ref: limit, refSite: "bar", src, pass, detail };
}

/** Page-type HTML budget in KB, or null when the page has none. */
export function htmlBudgetKb(page, budgets) {
  if (/^pdp/.test(page)) return budgets.pdpHtmlKB;
  if (page === "plp" || page === "leaf" || page === "search") return budgets.categoryHtmlKB;
  return null;
}

/**
 * Performance and size checks from one template's perf rows
 * ({ page: { ttfb: [{miss, hit}], phone: {lcp, cls}, desktop: {lcp, cls}, html: {bytes, headerBytes, jsonLdBytes, headerAnchors} } }).
 */
export function perfChecks(template, rows, budgets) {
  const checks = [];
  const src = "AUDIT §8 global bar";
  for (const [page, row] of Object.entries(rows)) {
    if (row.ttfb?.length) {
      checks.push(budgetCheck("perf", template, page, "ttfb.missMs", median(row.ttfb.map((t) => t.miss)), budgets.ttfbMissMs, `${src}: local miss <= ${budgets.ttfbMissMs} ms (median of runs)`));
      checks.push(budgetCheck("perf", template, page, "ttfb.hitMs", median(row.ttfb.map((t) => t.hit)), budgets.ttfbHitMs, `${src}: hit <= ${budgets.ttfbHitMs} ms`));
    }
    if (row.phone) {
      checks.push(budgetCheck("perf", template, page, "phone.lcpMs", row.phone.lcp, budgets.lcpPhoneMs, `${src}: phone LCP <= ${budgets.lcpPhoneMs} ms`));
      checks.push(budgetCheck("perf", template, page, "phone.cls", row.phone.cls, budgets.cls, `${src}: CLS <= ${budgets.cls}`));
    }
    if (row.desktop) {
      checks.push(budgetCheck("perf", template, page, "desktop.lcpMs", row.desktop.lcp, budgets.lcpDesktopMs, `${src}: desktop LCP <= ${budgets.lcpDesktopMs} ms`));
      checks.push(budgetCheck("perf", template, page, "desktop.cls", row.desktop.cls, budgets.cls, `${src}: CLS <= ${budgets.cls}`));
    }
    const html = row.html;
    if (html) {
      const limit = htmlBudgetKb(page, budgets);
      if (limit) checks.push(budgetCheck("size", template, page, "html.kb", round(html.bytes / 1024, 1), limit, `${src}: ${/^pdp/.test(page) ? "product" : "category"} HTML <= ${limit} KB`));
      if (html.headerBytes != null) checks.push(budgetCheck("size", template, page, "header.kb", round(html.headerBytes / 1024, 1), budgets.headerHtmlKB, `${src}: header HTML <= ${budgets.headerHtmlKB} KB`));
      if (html.jsonLdBytes != null && /^pdp/.test(page)) checks.push(budgetCheck("size", template, page, "jsonLd.kb", round(html.jsonLdBytes / 1024, 1), budgets.jsonLdKB, `${src}: JSON-LD <= ${budgets.jsonLdKB} KB`));
      if (html.headerAnchors != null) checks.push(budgetCheck("size", template, page, "header.anchors", html.headerAnchors, budgets.headerAnchors, `${src}: header anchors <= ${budgets.headerAnchors}`));
    }
  }
  return checks;
}

/**
 * Navigation-at-scale checks for one template x menu (slice 1 bar): the menu
 * never disappears, 0 clipped links with and without JavaScript, 0 duplicate
 * drawer labels, header anchors and HTML within budget.
 */
export function navChecks(template, menu, r, budgets) {
  const checks = [];
  const src = "AUDIT §8 slice 1";
  const add = (viewport, metric, value, limit, rule, note) => checks.push({ ...budgetCheck("nav", template, viewport, `${menu}.${metric}`, value, limit, `${src}: ${note}`, rule) });
  for (const width of [1440, 1280, 1024]) {
    const d = r[`d${width}`];
    if (!d) continue;
    add(`d${width}`, "menuLinks", d.menuLinks == null ? null : d.menuLinks > 0, true, "true", "a menu never disappears (menu links in the header or drawer)");
    add(`d${width}`, "clipped", d.nav?.clipped?.length ?? null, 0, "zero", "0 clipped links");
    if (width === 1440) {
      add("d1440", "headerAnchors", d.headerLinks ?? null, budgets.headerAnchors, "max", `header anchors <= ${budgets.headerAnchors}`);
      add("d1440", "headerKB", d.headerBytes != null ? round(d.headerBytes / 1024, 1) : null, budgets.headerHtmlKB, "max", `header HTML <= ${budgets.headerHtmlKB} KB`);
    }
  }
  if (r.noJsDesktop) add("d1440-nojs", "clipped", r.noJsDesktop.nav?.clipped ?? null, 0, "zero", "no-JS fallback never clips");
  if (r.noJs1024) add("d1024-nojs", "clipped", r.noJs1024.nav?.clipped ?? null, 0, "zero", "no-JS fallback never clips");
  if (r.drawer !== undefined) add("phone", "drawerDuplicates", r.drawer ? r.drawer.duplicates.length : null, 0, "zero", "0 duplicate labels in any drawer");
  return checks;
}

/** Card variant distinctness (slice 2 bar): every pair differs by >= N% of pixels. */
export function variantChecks(template, diffs, budgets, { structural = [], photos = [], plain = {} } = {}) {
  const checks = diffs.map((d) => budgetCheck("variants", template, d.viewport, `card.${d.a}~${d.b}.diffPct`, d.pct, budgets.cardVariantMinDiffPct, `AUDIT §8 slice 2: any two card variants differ by >= ${budgets.cardVariantMinDiffPct}% of pixels (on the product with every signal)`, "min"));
  // Slice 2b: what a buyer notices, pair by pair.
  for (const s of structural) {
    const check = budgetCheck("variants", template, s.viewport, `card.${s.a}~${s.b}.treatments`, s.count, budgets.cardVariantMinTreatments, `slice 2b: any two card variants differ in >= ${budgets.cardVariantMinTreatments} buyer-visible treatments`, "min");
    checks.push({ ...check, detail: `${check.detail}: ${s.differing.join(", ") || "none"}` });
  }
  // A desktop card photo is fetched at most 1.2x its drawn width (DPR 1).
  for (const p of photos.filter((photo) => photo.viewport === "desktop")) {
    checks.push(budgetCheck("variants", template, "desktop", `card.${p.variant}.photoRatio`, p.ratio, budgets.cardPhotoMaxRatio, `slice 2b: a card photo is fetched at <= ${budgets.cardPhotoMaxRatio}x its drawn width (${p.fetched}w for ${p.drawn}px)`));
  }
  // The plain product (no facts at all) still renders a whole card with phone titles at the Bangla floor.
  for (const [key, card] of Object.entries(plain)) {
    const [variant, viewport] = [key.slice(0, key.lastIndexOf("-")), key.slice(key.lastIndexOf("-") + 1)];
    checks.push({ id: `${template}/variants/${viewport}/card.${variant}.plainRenders`, template, block: "variants", viewport, metric: `card.${variant}.plainRenders`, rule: "true", ours: !card.empty && card.box.h > 0, ref: true, refSite: "bar", src: "slice 2b: a card without facts renders whole", pass: !card.empty && card.box.h > 0, detail: card.empty ? "empty card" : `${Math.round(card.box.w)}x${Math.round(card.box.h)}` });
    if (viewport === "phone") checks.push(budgetCheck("variants", template, "phone", `card.${variant}.titlePx`, card.titleFontPx, budgets.cardPhoneTitleMinPx, `phone titles never below ${budgets.cardPhoneTitleMinPx}px`, "min"));
  }
  return checks;
}


/** Hover photo latency (slice 2 bar). */
export function hoverChecks(template, samples, budgets) {
  return samples.map((s) => budgetCheck("hover", template, "desktop", `card${s.idx}.visibleAfterMs`, s.visibleAfterMs >= 0 ? s.visibleAfterMs : null, budgets.hoverVisibleMs, `AUDIT §8 slice 2: hover photo painted <= ${budgets.hoverVisibleMs} ms after pointerenter at 10 Mbps / 60 ms`));
}

/**
 * `--only a,b`: template names and block names. A check is kept when it
 * matches the named templates (if any) and the named blocks (if any).
 */
export function parseOnly(only, templates, blocks) {
  const names = (only ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !templates.includes(n) && !blocks.includes(n));
  if (unknown.length) throw new Error(`--only: unknown ${unknown.join(", ")} (templates: ${templates.join(", ")}; blocks: ${blocks.join(", ")})`);
  return { templates: names.filter((n) => templates.includes(n)), blocks: names.filter((n) => blocks.includes(n)) };
}

export function selected(filter, template, block) {
  return (!filter.templates.length || filter.templates.includes(template) || template === "*")
    && (!filter.blocks.length || filter.blocks.includes(block));
}

/** Counts per template and block, and the overall verdict. */
export function summarize(checks) {
  const byTemplate = {};
  const byBlock = {};
  for (const c of checks) {
    byTemplate[c.template] ??= { pass: 0, fail: 0 };
    byTemplate[c.template][c.pass ? "pass" : "fail"] += 1;
    byBlock[c.block] ??= { pass: 0, fail: 0 };
    byBlock[c.block][c.pass ? "pass" : "fail"] += 1;
  }
  const failed = checks.filter((c) => !c.pass).length;
  return { total: checks.length, passed: checks.length - failed, failed, byTemplate, byBlock };
}

/** Process exit code: 1 on any breach unless report-only; 2 when nothing was checked. */
export function exitCode(checks, { reportOnly = false } = {}) {
  if (!checks.length) return 2;
  if (reportOnly) return 0;
  return checks.some((c) => !c.pass) ? 1 : 0;
}

/** Share of pixels whose grey level differs by more than `threshold` (the audit's card metric). */
export function pixelDiffPct(a, b, threshold = 28) {
  if (a.length !== b.length) throw new Error("buffers differ in size");
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) if (Math.abs(a[i] - b[i]) > threshold) diff += 1;
  return round((diff / a.length) * 100, 1);
}
