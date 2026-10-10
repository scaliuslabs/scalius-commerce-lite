// One page of the dashboard quality audit: open a route (or a surface) at one
// width and language, run every check, and return the findings and metrics.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { globMatch, focusVisibleCheck } from "../quality-shared/page-checks.mjs";
import {
  THRESHOLDS,
  classifyClip,
  compileLanguageAllowlist,
  controlHeightFindings,
  fieldAlignmentFindings,
  stackGapFindings,
  findEnglishInBn,
  findLeaks,
  skeletonShapeFinding,
} from "./analysis.mjs";
import { collectFacts, installResponseProbe, markFocused, readResponse } from "./page-facts.mjs";
import { isGating, polishIds } from "./rules.mjs";

export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const VIEWPORT_HEIGHT = 900;
const SETTLE_TIMEOUT_MS = 15_000;
const CLS_WINDOW_MS = 3_000;
const FOCUS_STEPS = 15;
const SCREENSHOT_MAX_HEIGHT = 5_000;

const finding = (rule, impact, message, nodes = [], count = nodes.length || 1) => ({ rule, source: "harness", impact, message, count, nodes: nodes.slice(0, 10) });
const pathOf = (url) => {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
};

/** The titles of the dashboard's own error and not-found screens, read from its catalog (en and bn). */
export function errorScreenPatterns(catalogSource) {
  const titles = [...catalogSource.matchAll(/^\s*(?:notFoundTitle|errorTitle|offlineTitle|unavailableTitle):\s*"([^"]+)"/gm)].map((match) => match[1]);
  return titles;
}

function matchesAllowlist(list, url, status) {
  return list.find((item) => globMatch(item.url, pathOf(url)) && (!item.status || item.status === status)) ?? null;
}

/** Console and network listeners for one page; `read()` returns what they saw. */
function attachListeners(page, { baseOrigin, allowlist }) {
  const consoleErrors = [];
  const pageErrors = [];
  const network = [];
  const consoleIgnore = allowlist.console.map((item) => new RegExp(item.match));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (consoleIgnore.some((pattern) => pattern.test(text))) return;
    consoleErrors.push(text.slice(0, 200));
  });
  page.on("pageerror", (error) => pageErrors.push(String(error.message ?? error).slice(0, 200)));
  page.on("response", (response) => {
    const url = response.url();
    if (!url.startsWith(baseOrigin) || response.status() < 400) return;
    if (matchesAllowlist(allowlist.network, url, response.status())) return;
    network.push({ status: response.status(), method: response.request().method(), path: pathOf(url) });
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (!url.startsWith(baseOrigin)) return;
    const reason = request.failure()?.errorText ?? "";
    if (/ERR_ABORTED|ERR_FAILED/.test(reason)) return; // navigations and cancelled reads
    network.push({ status: 0, method: request.method(), path: pathOf(url), reason });
  });
  return { read: () => ({ consoleErrors, pageErrors, network }) };
}

async function waitForSettled(page) {
  const started = Date.now();
  while (Date.now() - started < SETTLE_TIMEOUT_MS) {
    const settled = await page.evaluate(() => window.__adminQuality?.settledAt ?? null).catch(() => null);
    if (settled !== null) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function runAxe(page, axeSource) {
  if (!(await page.evaluate(() => typeof window.axe !== "undefined"))) await page.addScriptTag({ content: axeSource });
  return await page.evaluate(async (tags) => {
    const results = await window.axe.run(document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
    return results.violations.map((violation) => ({
      rule: violation.id, source: "axe", impact: violation.impact ?? "minor", message: violation.help, help: violation.helpUrl,
      count: violation.nodes.length, nodes: violation.nodes.slice(0, 10).map((node) => node.target.join(" ")),
    }));
  }, AXE_TAGS);
}

/** The static rules over the facts collected in the page. */
export function judgeFacts(facts, { locale, languageAllow }) {
  const findings = [];
  const { page } = facts;
  if (facts.scrollerOverflow) {
    findings.push(finding("overflow-page", "serious", `The main scroller scrolls sideways: ${facts.scrollerOverflow.scrollWidth}px of content in ${facts.scrollerOverflow.clientWidth}px.`, ["#admin-main-scroll"]));
  }
  if (page.scrollWidth > page.clientWidth + 1 || facts.offenders.length) {
    findings.push(finding(
      "overflow-page", "serious",
      page.scrollWidth > page.clientWidth + 1
        ? `The page scrolls sideways: ${page.scrollWidth}px of content in a ${page.clientWidth}px viewport.`
        : "Content reaches past the right edge and is cut off.",
      facts.offenders.length ? facts.offenders : [`${page.scrollWidth}/${page.clientWidth}`],
    ));
  }
  if (facts.containers.length) {
    findings.push(finding("overflow-container", "serious", "A card or table is wider than the box that holds it.", facts.containers.map((item) => `${item.sel}: ${item.contentWidth}px in ${item.boxWidth}px (overflow-x ${item.overflowX})`)));
  }
  if (facts.scrollingTables.length) {
    findings.push(finding("table-scroll", "moderate", "A table scrolls sideways inside its card.", facts.scrollingTables.map((item) => `${item.sel}: ${item.tableWidth}px in ${item.boxWidth}px`)));
  }

  const clipped = [];
  const truncated = [];
  for (const clip of facts.clips) {
    const verdict = classifyClip(clip);
    if (verdict?.rule === "clipped-text") clipped.push(`${clip.sel} "${clip.text}" (${clip.sw}px in ${clip.cw}px)`);
    else if (verdict?.rule === "truncated-no-title") truncated.push(`${clip.sel} "${clip.text}"`);
  }
  if (clipped.length) findings.push(finding("clipped-text", "moderate", "Text is cut off with no ellipsis.", clipped));
  if (truncated.length) findings.push(finding("truncated-no-title", "moderate", "Text is truncated and its full value has no title, label or tooltip.", truncated));

  for (const item of controlHeightFindings(facts.controls)) findings.push(finding("control-height", "moderate", item.message, item.nodes));
  for (const item of fieldAlignmentFindings(facts.fields)) findings.push(finding("field-misaligned", "moderate", item.message, item.nodes));

  // The polish bar's geometry rules.
  if (facts.controlSizes.wrong.length) findings.push(finding("control-size", "moderate", `Fields should be ${facts.controlSizes.target}px tall at this width.`, facts.controlSizes.wrong, facts.controlSizes.wrong.length));
  if (facts.touch.length) findings.push(finding("touch-target", "moderate", "Touch targets under 24x24 px (or under 44 px tall on a phone).", facts.touch, facts.touch.length));
  if (facts.primaries.page.length > 1) findings.push(finding("multiple-primary", "moderate", `${facts.primaries.page.length} primary buttons in one view.`, facts.primaries.page));
  if (facts.primaries.dialogs.length) findings.push(finding("multiple-primary", "moderate", "More than one primary button in an open dialog.", facts.primaries.dialogs));
  if (facts.dialogs.length > 1) findings.push(finding("dialog-stack", "moderate", `${facts.dialogs.length} dialogs are open at once.`, facts.dialogs.map((item) => item.sel)));
  const oddDialogs = facts.viewportWidth >= 640 ? facts.dialogs.filter((item) => ![448, 512, 640, 800].includes(item.width)) : [];
  if (oddDialogs.length) findings.push(finding("dialog-width", "minor", "A dialog is not 448, 512, 640 or 800 px wide.", oddDialogs.map((item) => `${item.sel} (${item.width}px)`)));
  if (facts.rowHeights.length) findings.push(finding("row-height", "moderate", "Rows of one table differ in height.", facts.rowHeights.map((item) => `${item.sel}: ${item.min}-${item.max}px over ${item.rows} rows`)));
  if (facts.numeric.length) findings.push(finding("numeric-align", "moderate", "A numeric column is not end-aligned with tabular digits.", facts.numeric));
  if (facts.rowLinks.length) findings.push(finding("row-link", "minor", "No row of this table opens by a real link (Cmd-click, middle-click).", facts.rowLinks));
  if (facts.labelClips.length) findings.push(finding("label-truncated", "moderate", "A button, tab, label or heading is wider than its box.", facts.labelClips, facts.labelClips.length));
  if (facts.unitLabels.length) findings.push(finding("unit-in-label", "moderate", "A label carries its unit in brackets.", facts.unitLabels));
  const gaps = stackGapFindings(facts.gapPairs);
  if (gaps.label.length) findings.push(finding("label-gap", "moderate", "A label is not 4 px above its control.", gaps.label));
  if (gaps.help.length) findings.push(finding("help-gap", "moderate", "Help or error text is not 4 px under its control.", gaps.help));

  const leaks = findLeaks(facts.texts);
  if (leaks.length) findings.push(finding("leaked-value", "serious", `A visible value is ${[...new Set(leaks.map((leak) => leak.label))].join(", ")}.`, leaks.map((leak) => `${leak.kind}: "${leak.text}" in ${leak.sel}`), leaks.length));

  if (locale === "bn") {
    const english = findEnglishInBn(facts.texts, languageAllow);
    if (english.length) findings.push(finding("wrong-language", "moderate", "English text in the Bangla dashboard.", english.map((item) => `"${item.text}" [${item.words.join(", ")}] in ${item.sel}`), english.length));
  }
  if (!facts.htmlLang.toLowerCase().startsWith(locale)) {
    findings.push(finding("html-lang", "moderate", `The page language is "${facts.htmlLang || "(none)"}"; the dashboard shows "${locale}".`, ["html"]));
  }
  return findings;
}

async function tabThrough(page, { insideDialog }) {
  await page.evaluate(() => {
    document.activeElement?.blur?.();
    window.scrollTo(0, 0);
  });
  const path = [];
  for (let step = 0; step < FOCUS_STEPS; step += 1) {
    await page.keyboard.press("Tab");
    path.push(await page.evaluate(markFocused));
  }
  const findings = [];
  // A dialog with one control keeps Tab on it by design: only a page can strand focus.
  const stuck = insideDialog ? [] : path.filter((item, index) => index > 0 && item.sel && item.sel === path[index - 1].sel);
  const lost = path.filter((item) => !item.sel);
  const covered = path.filter((item) => item.underTopBar);
  if (covered.length) findings.push(finding("focus-obscured", "serious", "A focused control sits under the top bar.", [...new Set(covered.map((item) => item.sel))]));
  const leaked = insideDialog ? path.filter((item) => item.sel && !item.dialog) : [];
  if (stuck.length) findings.push(finding("focus-trap", "serious", "Tab pressed twice left focus on the same element.", [...new Set(stuck.map((item) => item.sel))]));
  if (lost.length >= 3) findings.push(finding("focus-trap", "serious", `Focus left the page ${lost.length} times in ${FOCUS_STEPS} Tab presses.`, ["document.body"], lost.length));
  if (leaked.length) findings.push(finding("focus-trap", "serious", "Tab moved focus out of the open dialog.", [...new Set(leaked.map((item) => item.sel))], leaked.length));
  const ring = await page.evaluate(focusVisibleCheck);
  if (ring.count) findings.push(finding("focus-visible", "serious", `${ring.count} of ${ring.judged} controls look the same focused and unfocused (WCAG 2.4.7).`, ring.missing, ring.count));
  return { findings, tabStops: path.filter((item) => item.sel).length };
}

async function measureInteraction(page, name, act, { ignoreSelector } = {}) {
  await page.evaluate(installResponseProbe, { ignoreSelector: ignoreSelector ?? null });
  await act();
  await page.waitForTimeout(450);
  const result = await page.evaluate(readResponse);
  return { name, ...result };
}

/** Switch a tab and type in the list search: the small named set every route can offer. */
async function genericInteractions(page) {
  const measured = [];
  const search = page.locator('main input[type="search"], main [role="searchbox"], main input[placeholder*="earch" i], main input[placeholder*="খুঁজ"]').first();
  if ((await search.count()) && (await search.isVisible().catch(() => false))) {
    measured.push(await measureInteraction(page, "list-search", async () => {
      await search.click({ timeout: 3_000 }).catch(() => {});
      await page.keyboard.type("a", { delay: 20 });
    }, { ignoreSelector: "input,[role=searchbox]" }));
    await search.fill("").catch(() => {});
    await page.waitForTimeout(250);
  }
  const tab = page.locator('main [role="tab"][aria-selected="false"]:not([disabled]):not([aria-disabled="true"])').first();
  if ((await tab.count()) && (await tab.isVisible().catch(() => false))) {
    measured.push(await measureInteraction(page, "tab-switch", async () => {
      await tab.click({ timeout: 3_000 }).catch(() => {});
    }));
  }
  return measured;
}

/** A surface's steps (open a dialog, a sheet or a menu); the step marked `measure` is timed. */
async function runSurfaceSteps(page, surface) {
  const measured = [];
  for (const step of surface.steps ?? []) {
    const act = async () => {
      if (step.press) await page.keyboard.press(step.press);
      else if (step.click) await page.locator(step.click).first().click({ timeout: 5_000 });
      else if (step.fill) await page.locator(step.fill[0]).first().fill(step.fill[1], { timeout: 5_000 });
      else if (step.wait) await page.waitForTimeout(step.wait);
    };
    if (step.measure) measured.push(await measureInteraction(page, step.measure, act));
    else await act();
  }
  if (surface.waitFor) await page.locator(surface.waitFor).first().waitFor({ state: "visible", timeout: 5_000 });
  await page.waitForTimeout(400);
  return measured;
}

/** Q2: Esc closes the surface and focus returns to the control that opened it. */
async function checkFocusReturn(page, surface, findings) {
  const step = (surface.steps ?? []).find((item) => item.click);
  if (!step) return;
  const trigger = page.locator(step.click).first();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
  const closed = (await page.locator(surface.waitFor).first().isVisible().catch(() => false)) === false;
  if (!closed) return; // Esc does not close it: another rule's business
  const returned = await trigger.evaluate((element) => element === document.activeElement).catch(() => false);
  if (!returned) findings.push(finding("focus-return", "serious", "Esc closed the surface but focus did not return to its trigger.", [step.click]));
}

async function screenshot(page, file) {
  mkdirSync(dirname(file), { recursive: true });
  const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.scrollHeight }));
  await page.addStyleTag({ content: "*{content-visibility:visible!important}" }).catch(() => {});
  await page.screenshot({
    path: file, type: "jpeg", quality: 55, animations: "disabled", caret: "hide", timeout: 30_000,
    fullPage: size.height > VIEWPORT_HEIGHT,
    ...(size.height > VIEWPORT_HEIGHT ? { clip: { x: 0, y: 0, width: size.width, height: Math.min(size.height, SCREENSHOT_MAX_HEIGHT) } } : {}),
  });
}

/**
 * Audits one job at one width: { job: { id, family, url, public, surface? }, width, locale }.
 * Returns { findings, metrics, screenshot }.
 */
export async function auditPage({ context, job, width, locale, baseOrigin, axeSource, allowlist, languageAllow, errorTitles, out, shots }) {
  const findings = [];
  const page = await context.newPage();
  const listeners = attachListeners(page, { baseOrigin, allowlist });
  const metrics = { cls: 0 };
  let shotPath = null;
  try {
    await page.setViewportSize({ width, height: VIEWPORT_HEIGHT });
    const response = await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!response || response.status() >= 400) {
      findings.push(finding("render", "critical", `The document answered ${response?.status() ?? "nothing"}.`));
      return { findings: finalize(findings), metrics, screenshot: null };
    }
    const settled = await waitForSettled(page);
    const timing = await page.evaluate(() => ({ ...window.__adminQuality, now: performance.now() }));
    metrics.fcpMs = timing.fcp === null ? null : Math.round(timing.fcp);
    metrics.settledMs = timing.settledAt === null ? null : Math.round(timing.settledAt);
    if (!settled) findings.push(finding("load-stuck", "serious", `A skeleton or busy state was still on screen after ${SETTLE_TIMEOUT_MS / 1000} s.`, []));
    if (metrics.fcpMs !== null && metrics.fcpMs > THRESHOLDS.firstRenderMs) findings.push(finding("load-first-render", "moderate", `First contentful paint at ${metrics.fcpMs} ms (flag above ${THRESHOLDS.firstRenderMs} ms).`));
    if (metrics.settledMs !== null && metrics.settledMs > THRESHOLDS.settledMs) findings.push(finding("load-settled", "moderate", `Content settled at ${metrics.settledMs} ms (flag above ${THRESHOLDS.settledMs} ms).`));
    if (timing.skeletonSeen) {
      const shape = skeletonShapeFinding(timing.skeletonHeight, timing.finalHeight);
      if (shape) findings.push(finding("skeleton-shape", "moderate", shape.message));
    }

    // The layout-shift window: three seconds after the content settled.
    const elapsed = Math.max(0, (timing.settledAt ?? timing.now) + CLS_WINDOW_MS - timing.now);
    if (job.surface) await runSurfaceOpen(page, job, findings, metrics);
    await page.waitForTimeout(Math.min(elapsed, CLS_WINDOW_MS));
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    const cls = await page.evaluate(() => ({ value: window.__galleryCls ?? 0, sources: window.__galleryShifts ?? [] }));
    metrics.cls = Number(cls.value.toFixed(4));
    if (cls.value > THRESHOLDS.cls) findings.push(finding("layout-shift", cls.value > 0.25 ? "serious" : "moderate", `CLS ${cls.value.toFixed(3)} over the load plus ${CLS_WINDOW_MS / 1000} s (good is ${THRESHOLDS.cls} or less).`, cls.sources, 1));

    // Where the route ended, and whether it rendered.
    const finalPath = pathOf(page.url()).replace(/\/$/, "") || "/";
    const wantedPath = pathOf(job.url).replace(/\/$/, "") || "/";
    if (finalPath !== wantedPath) findings.push(finding("redirected", "minor", `The route ended on ${finalPath}.`, [finalPath]));
    const facts = await page.evaluate(collectFacts);
    metrics.scrollWidth = facts.page.scrollWidth;
    metrics.clientWidth = facts.page.clientWidth;
    const errorTitle = facts.texts.find((item) => errorTitles.includes(item.text) && !item.data);
    if (errorTitle) findings.push(finding("render", "critical", `The page shows its error or not-found screen: "${errorTitle.text}".`, [errorTitle.sel]));
    else if (!facts.main.exists || (facts.main.textLength === 0 && !facts.main.hasMedia)) findings.push(finding("blank-page", "critical", "The page settled with no content in main."));
    findings.push(...judgeFacts(facts, { locale, languageAllow }));

    findings.push(...(await runAxe(page, axeSource)));

    if (shots) {
      const relative = `shots/${job.id}/${width}-${locale}.jpg`;
      try {
        await screenshot(page, join(out, relative));
        shotPath = relative;
      } catch (error) {
        findings.push(finding("screenshot", "minor", `No screenshot: ${String(error.message).slice(0, 160)}`));
      }
    }

    // Keyboard and interaction come last: they change the page.
    // A menu or popover handles its own arrow keys and closes on Tab: only pages and dialogs are walked.
    if (!job.surface || job.surface.modal) {
      const focus = await tabThrough(page, { insideDialog: Boolean(job.surface?.modal) });
      findings.push(...focus.findings);
      metrics.tabStops = focus.tabStops;
    }
    if (job.surface) await checkFocusReturn(page, job.surface, findings);
    if (!job.surface) {
      const measured = await genericInteractions(page);
      metrics.interactions = Object.fromEntries(measured.map((item) => [item.name, item.ms === null ? null : Math.round(item.ms)]));
      for (const item of measured) {
        if (item.ms !== null && item.ms > THRESHOLDS.interactionMs) findings.push(finding("interaction-latency", "moderate", `${item.name}: first visual response after ${Math.round(item.ms)} ms (flag above ${THRESHOLDS.interactionMs} ms).`));
      }
    }

    const seen = listeners.read();
    if (seen.pageErrors.length) findings.push(finding("page-error", "serious", "An uncaught script error.", [...new Set(seen.pageErrors)]));
    if (seen.consoleErrors.length) findings.push(finding("console-error", "minor", "The page logged errors.", [...new Set(seen.consoleErrors)], seen.consoleErrors.length));
    const server = seen.network.filter((item) => item.status >= 500);
    const client = seen.network.filter((item) => item.status < 500);
    const label = (item) => `${item.method} ${item.path} ${item.status || item.reason}`;
    if (server.length) findings.push(finding("network-5xx", "serious", "A request answered 5xx.", [...new Set(server.map(label))], server.length));
    if (client.length) findings.push(finding("network-error", "moderate", "A request answered 4xx or failed.", [...new Set(client.map(label))], client.length));
    return { findings: finalize(findings), metrics, screenshot: shotPath };
  } finally {
    await page.close().catch(() => {});
  }
}

async function runSurfaceOpen(page, job, findings, metrics) {
  try {
    const measured = await runSurfaceSteps(page, job.surface);
    metrics.interactions = Object.fromEntries(measured.map((item) => [item.name, item.ms === null ? null : Math.round(item.ms)]));
    for (const item of measured) {
      if (item.ms !== null && item.ms > THRESHOLDS.interactionMs) findings.push(finding("interaction-latency", "moderate", `${item.name}: first visual response after ${Math.round(item.ms)} ms (flag above ${THRESHOLDS.interactionMs} ms).`));
    }
  } catch (error) {
    findings.push(finding("render", "critical", `The surface did not open: ${String(error.message).split("\n")[0].slice(0, 160)}`));
  }
}

function finalize(findings) {
  for (const item of findings) {
    item.help ??= null;
    item.gating = isGating(item);
    item.polish = polishIds(item);
    if (item.polish.length) item.message = `[${item.polish.join(", ")}] ${item.message}`;
  }
  return findings;
}

export { compileLanguageAllowlist };
