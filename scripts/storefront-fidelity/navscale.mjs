// Header and navigation at scale (AUDIT §3.1): templates x scale menus x
// {1440, 1280, 1024}, the open panel, "More", keyboard, the phone drawer and
// its second level, and the no-JavaScript header. Run through check.mjs.
import { sleep } from "./lib/proc.mjs";
import { applyTheme } from "./lib/theme.mjs";
import { PROBE } from "./matrix.mjs";
import { MENUS } from "./menus.mjs";

const PANEL_PROBE = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
  const panels = [...document.querySelectorAll('[data-nav-panel], .nav-dropdown, .mega-panel, .cnav-panel, .flyout, [role=menu], .nav-mega, details[open] > ul, details[open] > div')]
    .filter((e) => vis(e) && e.getBoundingClientRect().height > 30);
  return panels.slice(0, 4).map((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    const groups = [...e.querySelectorAll(':scope ul, :scope [data-nav-group]')].filter(vis);
    return { cls: (e.className || '').toString().slice(0, 50), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      bottomOver: Math.round(Math.max(0, r.bottom - innerHeight)), rightOver: Math.round(Math.max(0, r.right - innerWidth)),
      scrolls: e.scrollHeight > e.clientHeight + 2 && /auto|scroll/.test(s.overflowY), links: e.querySelectorAll('a').length,
      visibleLinks: [...e.querySelectorAll('a')].filter(vis).length, groups: groups.length,
      rowH: (() => { const a = [...e.querySelectorAll('a')].find(vis); return a ? Math.round(a.getBoundingClientRect().height) : null; })() }; });
})()`;

const DRAWER_PROBE = `(() => {
  const panel = [...document.querySelectorAll('[data-drawer]')].find((d) => { const r = d.getBoundingClientRect(); return r.width > 0 && r.left >= -2 && getComputedStyle(d).visibility !== 'hidden'; });
  if (!panel) return null;
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0 && getComputedStyle(el).visibility !== 'hidden'; };
  const rows = [...panel.querySelectorAll('a, button')].filter(vis).filter((a) => !/close|social|facebook|youtube|whatsapp/i.test(a.getAttribute('aria-label') || ''));
  const labels = rows.map((a) => (a.innerText || '').trim().replace(/\\s+/g, ' ')).filter(Boolean);
  const dup = [...new Set(labels.filter((l, i) => labels.indexOf(l) !== i))];
  return { title: panel.getAttribute('aria-label'), w: Math.round(panel.getBoundingClientRect().width), visibleRows: labels.length, totalLinks: panel.querySelectorAll('a').length,
    rowH: rows.slice(1, 7).map((a) => Math.round(a.getBoundingClientRect().height)), first: labels.slice(0, 14), duplicates: dup,
    tallRows: rows.filter((a) => a.getBoundingClientRect().height > 60).map((a) => (a.innerText || '').trim().slice(0, 40)),
    overflowX: rows.filter((a) => a.scrollWidth > a.clientWidth + 2).length,
    expanders: panel.querySelectorAll('button[aria-expanded], .drill-next, [data-drill-target], summary').length };
})()`;

// menuLinks: links to menu targets (every scale menu targets categories) in the
// header or any drawer, rendered or folded; 0 means the menu is gone.
const HEADER_WEIGHT = "(() => { const h = document.getElementById('site-header'); const menu = new Set(document.querySelectorAll('#site-header a[href*=\"/categories/\"], [data-drawer] a[href*=\"/categories/\"]')); return { headerBytes: h ? h.outerHTML.length : 0, headerLinks: h ? h.querySelectorAll('a[href]').length : 0, menuLinks: menu.size }; })()";

const OPEN_FIRST = `(() => { const main = document.getElementById('main-header'); if (!main) return null;
  const cand = [...main.querySelectorAll('[aria-expanded], summary, [data-drawer-trigger], [aria-controls]')].filter(e => e.getBoundingClientRect().width > 0 && !e.closest('[data-drawer]'));
  const el = cand.find(e => !/search|cart|account|menu-toggle/i.test(e.id + ' ' + (e.getAttribute('aria-label') || '')));
  if (!el) return null; el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); el.click(); return (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40); })()`;

const OPEN_MORE = "(() => { const el = [...document.querySelectorAll('#main-header button, #main-header summary')].find(e => /^(more|আরও)\\b/i.test((e.innerText || '').trim()) && e.getBoundingClientRect().width > 0); if (!el) return false; document.body.click(); el.click(); return true; })()";

const KEYBOARD = `(async () => { document.body.click(); const main = document.getElementById('main-header'); if (!main) return null;
  const first = [...main.querySelectorAll('nav a, nav button, nav summary, [data-nav-overflow] a, [data-nav-overflow] button, .drill-row-links a')].find(e => e.getBoundingClientRect().width > 0);
  if (!first) return null; first.focus(); const a0 = document.activeElement?.innerText?.trim().slice(0, 20);
  const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  key('ArrowRight'); await new Promise(r => setTimeout(r, 50)); const a1 = document.activeElement?.innerText?.trim().slice(0, 20);
  key('ArrowDown'); await new Promise(r => setTimeout(r, 150)); const a2 = document.activeElement?.innerText?.trim().slice(0, 20);
  const expanded = !!document.querySelector('#main-header [aria-expanded=true], #main-header details[open]');
  key('Escape'); await new Promise(r => setTimeout(r, 150)); const a3 = document.activeElement?.innerText?.trim().slice(0, 20);
  const stillOpen = !!document.querySelector('#main-header [aria-expanded=true], #main-header details[open]');
  return { start: a0, right: a1, down: a2, openedByDown: expanded, afterEscape: a3, closedByEscape: !stillOpen }; })()`;

const DRILL = `(() => { const panel = [...document.querySelectorAll('[data-drawer]')].find(d => d.getBoundingClientRect().left >= -2 && d.getBoundingClientRect().width > 0 && getComputedStyle(d).visibility !== 'hidden'); if (!panel) return null;
  const b = [...panel.querySelectorAll('button[aria-expanded], .drill-next, button[data-drill-target], summary')].find(e => e.getBoundingClientRect().width > 0); if (!b) return null; b.click(); return (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 40); })()`;

function navSummary(m) {
  return m.nav ? { ...m.nav, labels: m.nav.labels?.slice(0, 20) } : null;
}

/** @returns template -> menu key -> result */
export async function runNavscale(ctx, { templates, menus = Object.keys(MENUS), widths = [1440, 1280, 1024], into = {} }) {
  const { page, base, log } = ctx;
  const all = into;
  for (const template of templates) {
    all[template] ??= {};
    for (const key of menus) {
      if (all[template][key]) continue; // done before a stack restart
      await applyTheme(ctx, template, { menu: MENUS[key] });
      const r = {};
      const tag = `nav-${template}-${key}`;
      for (const width of widths) {
        await page.profile("desktop", { width, height: 900 });
        await page.nav(base + "/");
        const m = await page.eval(PROBE).catch((e) => ({ error: e.message }));
        const weight = await page.eval(HEADER_WEIGHT);
        r[`d${width}`] = { header: m.header, rows: m.headerRows, nav: navSummary(m), search: m.search, attrs: m.attrs, ...weight };
        if (width === 1440) {
          await page.shot(`${tag}-d-top`, { clip: { x: 0, y: 0, width: 1440, height: 220 } });
          const opened = await page.eval(OPEN_FIRST);
          await sleep(500);
          r.panel = { opened, panels: await page.eval(PANEL_PROBE) };
          if (opened) await page.shot(`${tag}-d-open`);
          if (await page.eval(OPEN_MORE)) {
            await sleep(400);
            r.more = await page.eval(PANEL_PROBE);
          }
          r.keyboard = await page.eval(KEYBOARD);
        }
      }
      await page.profile("phone");
      await page.nav(base + "/");
      await page.eval("document.getElementById('mobile-menu-toggle')?.click()");
      await sleep(700);
      r.drawer = await page.eval(DRAWER_PROBE);
      await page.shot(`${tag}-m-drawer`);
      const drilled = await page.eval(DRILL);
      await sleep(500);
      r.drawerLevel2 = drilled ? { drilled, ...(await page.eval(DRAWER_PROBE)) } : null;
      await page.send("Emulation.setScriptExecutionDisabled", { value: true });
      try {
        for (const width of [1440, 1024]) {
          await page.profile("desktop", { width, height: 900 });
          await page.nav(base + "/", { quietMs: 150 });
          const nj = await page.eval(PROBE).catch((e) => ({ error: e.message }));
          const summary = nj.nav ? { visibleLinks: nj.nav.visibleLinks, more: nj.nav.more, clipped: nj.nav.clipped.length } : nj;
          if (width === 1440) {
            r.noJsDesktop = { nav: summary };
            await page.shot(`${tag}-d-nojs`, { clip: { x: 0, y: 0, width: 1440, height: 220 } });
          } else r.noJs1024 = { nav: summary };
        }
      } finally {
        await page.send("Emulation.setScriptExecutionDisabled", { value: false });
      }
      all[template][key] = r;
      log(`  nav ${template} fid-${key}: 1440 links ${r.d1440?.nav?.visibleLinks} clipped ${r.d1440?.nav?.clipped?.length} | no-JS clipped ${r.noJsDesktop?.nav?.clipped} | anchors ${r.d1440?.headerLinks} | drawer rows ${r.drawer?.visibleRows} dups ${r.drawer?.duplicates?.length ?? "-"}`);
    }
  }
  return all;
}
