// Injected measurement probe (AUDIT §1): one JSON object of layout metrics for
// the page as rendered. Selectors follow the storefront's stable hooks
// (#site-header, #main-header, [data-theme-component="product-card"],
// [data-catalog-filters], #product-gallery, #product-actions). Read-only.
(() => {
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.01; };
  const R = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };
  const font = (el) => { if (!el) return null; const s = getComputedStyle(el); return `${parseFloat(s.fontSize)}/${s.fontWeight}`; };
  const lines = (el) => { if (!el) return null; const s = getComputedStyle(el); const lh = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.2; return Math.round(el.getBoundingClientRect().height / lh); };
  const out = { url: location.pathname + location.search, vw: innerWidth, scrollW: document.documentElement.scrollWidth, docH: document.documentElement.scrollHeight };
  const hdr = document.getElementById("site-header");
  out.attrs = hdr ? Object.fromEntries([...hdr.attributes].filter((a) => a.name.startsWith("data-") && !a.name.startsWith("data-astro")).map((a) => [a.name, a.value])) : null;
  const main = document.getElementById("main-header");
  if (main) {
    const topR = main.getBoundingClientRect();
    out.header = { ...R(main), top: Math.round(topR.top + scrollY) };
    out.headerRows = [...main.querySelectorAll(":scope > div, :scope > nav")].filter(vis).map((d) => ({ cls: (d.className || "").toString().split(" ")[0], h: Math.round(d.getBoundingClientRect().height) }));
    const s = main.querySelector("[data-header-search] input, .hsearch-input, [data-header-search]");
    out.search = s && vis(s) ? R(s.closest("form") || s) : null;
    const logo = main.querySelector(".hdr-logo"); out.logo = logo && vis(logo) ? R(logo) : null;
    // above the header (top bar)
    const above = [...document.body.querySelectorAll("body > *, body > * > *")].filter((e) => vis(e) && e.getBoundingClientRect().bottom <= topR.top + 1 && e.getBoundingClientRect().height > 8 && !e.contains(main));
    out.topBarH = above.length ? Math.max(...above.map((e) => Math.round(e.getBoundingClientRect().height))) : 0;
    // nav links in the header: clipping detection
    const links = [...main.querySelectorAll("a, summary, button")].filter((a) => vis(a) && !a.closest("[data-drawer], dialog, .nav-drawer, [hidden]"));
    const clipped = [];
    for (const a of links) {
      const r = a.getBoundingClientRect();
      let p = a.parentElement;
      while (p && p !== document.body) {
        const cs = getComputedStyle(p);
        if (cs.overflowX !== "visible" || cs.overflow !== "visible") {
          const pr = p.getBoundingClientRect();
          if (r.right > pr.right + 1 || r.left < pr.left - 1) clipped.push({ text: (a.innerText || "").trim().slice(0, 40), visibleW: Math.round(Math.max(0, Math.min(r.right, pr.right) - Math.max(r.left, pr.left))), fullW: Math.round(r.width) });
          break;
        }
        p = p.parentElement;
      }
      if (r.right > innerWidth + 1) clipped.push({ text: (a.innerText || "").trim().slice(0, 40), offscreen: true });
    }
    const navLinks = links.filter((a) => a.closest("nav, [data-nav-overflow], .hdr-menu-row, .drill-row-links, .cnav, .catbar"));
    out.nav = {
      visibleLinks: navLinks.length,
      labels: navLinks.slice(0, 30).map((a) => (a.innerText || "").trim().slice(0, 30)),
      more: !!links.find((a) => /^(more|আরও)\b/i.test((a.innerText || "").trim())),
      font: font(navLinks[0]),
      rowH: navLinks[0] ? Math.round(navLinks[0].getBoundingClientRect().height) : null,
      clipped,
    };
    out.headerLinksInHtml = main.querySelectorAll("a[href]").length;
  }
  out.siteHeaderLinksInHtml = hdr ? hdr.querySelectorAll("a[href]").length : null;
  // cards
  const cards = [...document.querySelectorAll('[data-theme-component="product-card"]')].filter(vis);
  if (cards.length) {
    const c = cards[0]; const cs = getComputedStyle(c);
    const media = c.querySelector(".product-card-media"); const img = c.querySelector("img.product-card-photo, img");
    const title = c.querySelector(".product-card-name, h3"); const price = c.querySelector(".product-card-price") || [...c.querySelectorAll("span,p,div")].filter((e) => /৳/.test(e.textContent) && e.children.length <= 2 && !e.querySelector("s")).sort((a, b) => parseFloat(getComputedStyle(b).fontSize) - parseFloat(getComputedStyle(a).fontSize))[0];
    const firstRowY = Math.round(c.getBoundingClientRect().top);
    const row = cards.filter((x) => Math.abs(Math.round(x.getBoundingClientRect().top) - firstRowY) < 3 && x.parentElement === c.parentElement);
    const gap = row.length > 1 ? Math.round(row[1].getBoundingClientRect().left - row[0].getBoundingClientRect().right) : null;
    const cta = [...c.querySelectorAll("button, [data-card-action-hint], .product-card-action, a.product-card-cta")].filter(vis).map((b) => ({ text: (b.innerText || b.getAttribute("aria-label") || "").trim().slice(0, 20), ...R(b), radius: getComputedStyle(b).borderRadius }));
    out.card = {
      variant: c.getAttribute("data-card-variant"), count: cards.length, ...R(c), cols: row.length, gap,
      radius: cs.borderRadius, border: cs.borderTopWidth, shadow: cs.boxShadow !== "none",
      media: media ? { ...R(media), ratio: +(media.getBoundingClientRect().width / media.getBoundingClientRect().height).toFixed(2), fit: img ? getComputedStyle(img).objectFit : null } : null,
      title: title ? { font: font(title), lines: lines(title), text: title.innerText.trim().slice(0, 50) } : null,
      price: price ? { font: font(price), color: getComputedStyle(price).color } : null,
      cta, bodyText: c.innerText.replace(/\s+/g, " ").trim().slice(0, 160),
      hoverImg: !!c.querySelector("img[data-card-hover], .product-card-hover, img + img"),
    };
  }
  // listing
  const filters = document.querySelector("[data-catalog-filters]");
  if (filters) {
    const box = filters.closest("aside") || filters;
    const facets = [...filters.querySelectorAll("details")].filter((d) => !/^Show \d+ more/.test((d.querySelector("summary")?.innerText || "").trim()));
    const rows = [...filters.querySelectorAll("label")].filter(vis);
    out.listing = {
      filterVisible: vis(filters), filterBox: vis(box) ? R(box) : null, facetGroups: facets.length,
      openGroups: facets.filter((f) => f.open || f.hasAttribute("open")).length,
      valueRowH: rows.slice(0, 6).map((l) => Math.round(l.getBoundingClientRect().height)),
      valueFont: font(rows[0]), visibleValueRows: rows.length,
      filterPanelH: vis(filters) ? Math.round(filters.getBoundingClientRect().height) : null,
      htmlCheckboxes: filters.querySelectorAll("input[type=checkbox]").length,
    };
    const bar = document.querySelector("[data-catalog-filter-bar]"); out.listing.phoneBar = bar && vis(bar) ? R(bar) : null;
  }
  const h1 = document.querySelector("main h1, h1"); out.h1 = h1 ? { font: font(h1), text: h1.innerText.trim().slice(0, 60), ...R(h1) } : null;
  // pdp
  const gal = document.getElementById("product-gallery");
  if (gal) {
    const stage = [...gal.querySelectorAll("[data-image-stage], [data-video-stage]")].find(vis);
    const thumbs = [...gal.querySelectorAll("[data-gallery-thumbnail]")].filter(vis);
    const buy = document.getElementById("product-actions");
    const buttons = [...document.querySelectorAll("[data-action=add-to-cart], [data-action=buy-now]")].filter(vis).map((b) => ({ text: b.innerText.trim().slice(0, 16), w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height), radius: getComputedStyle(b).borderRadius }));
    const h1p = document.querySelector("main h1, h1");
    const col = h1p ? h1p.parentElement : null;
    const priceEl = [...document.querySelectorAll("main span, main p, main div")].filter((e) => vis(e) && /৳/.test(e.textContent) && e.children.length <= 1 && e.getBoundingClientRect().top < (h1p ? h1p.getBoundingClientRect().bottom + 300 : 900) && !e.closest("s, del, [data-theme-component]")).sort((a, b) => parseFloat(getComputedStyle(b).fontSize) - parseFloat(getComputedStyle(a).fontSize))[0];
    const chips = [...document.querySelectorAll("[data-option-definition-id] button, [data-option-definition-id] label, [data-option-value]")].filter(vis);
    out.pdp = { gallery: R(gal), stage: stage ? R(stage) : null, thumbs: thumbs.length, thumbSize: thumbs[0] ? R(thumbs[0]) : null, thumbsLeftOfStage: !!(thumbs[0] && stage && thumbs[0].getBoundingClientRect().right <= stage.getBoundingClientRect().left + 2), buttons, price: priceEl ? font(priceEl) : null, chip: chips[0] ? R(chips[0]) : null, buyCol: col ? R(col.closest("section, aside, div[class*=col], div") || col) : null, buyTop: buy ? R(buy).y : null };
  }
  const f = document.querySelector("footer"); out.footer = f && vis(f) ? { ...R(f), variant: f.getAttribute("data-footer-variant"), links: f.querySelectorAll("a").length } : null;
  // weights: header HTML, JSON-LD, the whole document
  out.bytes = {
    document: document.documentElement.outerHTML.length,
    siteHeader: hdr ? hdr.outerHTML.length : 0,
    jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].reduce((n, s) => n + (s.textContent || "").length, 0),
    filters: filters ? filters.outerHTML.length : 0,
  };
  // listing density (document coordinates; the caller has scrolled through once)
  {
    const H = innerHeight, W = innerWidth;
    const visD = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== "hidden" && s.display !== "none"; };
    let all = [...document.querySelectorAll('[data-theme-component="product-card"]')].filter(visD);
    all = all.filter((c) => !all.some((o) => o !== c && o.contains(c)));
    const main = document.querySelector("main") || document.body;
    const inMain = all.filter((c) => main.contains(c));
    const rects = inMain.map((c) => { const r = c.getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, h: r.height, w: r.width }; })
      .filter((r) => r.w > 60 && r.h > 60).sort((a, b) => a.top - b.top || a.left - b.left);
    const top0 = scrollY;
    const inView = rects.filter((r) => { const vh = Math.max(0, Math.min(r.bottom - top0, H) - Math.max(r.top - top0, 0)); return vh >= r.h * 0.5; }).length;
    const boxes = [...document.querySelectorAll("input[type=checkbox], input[type=radio], [role=checkbox], input[type=range], input[type=number]")].filter(visD);
    const filterInView = boxes.filter((b) => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= H && r.left < W * 0.35; }).length;
    const nth = (n) => (rects[n - 1] ? Math.round(rects[n - 1].bottom) : null);
    out.density = {
      cards: rects.length, firstCardTop: rects[0] ? Math.round(rects[0].top) : null, cardW: rects[0] ? Math.round(rects[0].w) : null, cardH: rects[0] ? Math.round(rects[0].h) : null,
      cols: rects.length ? rects.filter((r) => Math.abs(r.top - rects[0].top) < 4).length : 0,
      productsFullyHalfVisible: inView, productsStartingAboveFold: rects.filter((r) => r.top < H - 40).length,
      filterControlsVisible: filterInView, bottomOf8: nth(8), bottomOf20: nth(20),
    };
    // facet column compactness: checkbox row pitch, label size, column width
    const fboxes = [...document.querySelectorAll("input[type=checkbox], [role=checkbox]")].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.left < W * 0.35; });
    const ys = fboxes.map((b) => b.getBoundingClientRect().top + scrollY).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < ys.length; i += 1) { const g = ys[i] - ys[i - 1]; if (g > 5 && g < 60) gaps.push(Math.round(g)); }
    gaps.sort((a, b) => a - b);
    const lab = fboxes[0] ? (fboxes[0].closest("label") || fboxes[0].parentElement) : null;
    let colW = null;
    if (fboxes[0]) { let e = fboxes[0]; while (e && e.getBoundingClientRect().width < 150) e = e.parentElement; colW = e ? Math.round(e.getBoundingClientRect().width) : null; }
    out.facets = { boxes: fboxes.length, firstBoxTop: ys[0] ? Math.round(ys[0]) : null, rowPitch: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null, labelFont: lab ? parseFloat(getComputedStyle(lab).fontSize) : null, columnW: colW };
  }
  return out;
})()
