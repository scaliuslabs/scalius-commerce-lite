// Offline real-editor regression. Build admin-v2 first, then run from the repo root:
// node apps/admin-v2/test-support/tiptap.browser.mjs
// Uses the emitted dashboard CSS; no server, API, credentials, or remote resources.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const app = resolve("apps/admin-v2");
const assets = resolve(app, "dist/assets/immutable");
let css = (await Promise.all((await readdir(assets))
  .filter((name) => name.endsWith(".css"))
  .map((name) => readFile(resolve(assets, name), "utf8")))).join("\n");
// Inline only locally built font assets; the browser still has no network.
const fontUrls = [...new Set([...css.matchAll(/url\(([^)]+\.woff2)\)/g)].map((match) => match[1].replace(/["']/g, "")))];
for (const url of fontUrls) {
  const name = url.split("/").at(-1);
  const bytes = await readFile(resolve(assets, name));
  css = css.split(url).join(`data:font/woff2;base64,${bytes.toString("base64")}`);
}
const shots = process.argv.includes("--shots") ? "/tmp/scalius-tiptap-shots" : null;
if (shots) await mkdir(shots, { recursive: true });

const bundle = await build({
  stdin: {
    resolveDir: app,
    loader: "tsx",
    contents: `
      import React, { useState } from "react";
      import { createRoot } from "react-dom/client";
      import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
      import { TiptapToolbarSkeleton } from "./src/components/ui/tiptap/TiptapToolbarSkeleton";
      import { TiptapEditor } from "./src/components/ui/tiptap/TiptapEditor";
      import { Button } from "./src/components/ui/button";
      import { setLocale } from "./src/i18n";
      setLocale(document.documentElement.dataset.locale === "bn" ? "bn" : "en");
      let changeCount = 0;
      window.__changeCount = () => changeCount;
      const initial = "<p>A comfortable everyday cotton shirt.</p>";
      function Fixture() {
        const [content, setContent] = useState(initial);
        return <main style={{ padding: 16 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <Button data-sample="empty" variant="outline" onClick={() => setContent("")}>Empty</Button>
            <Button data-sample="long" variant="outline" onClick={() => setContent(Array.from({ length: 30 }, (_, i) => "<p>Paragraph " + (i + 1) + ": Cotton fabric, comfortable fit, and everyday care.</p>").join(""))}>Long sample</Button>
          </div>
          <section data-fixture-card style={{ maxWidth: Number(document.documentElement.dataset.cardWidth || 660), padding: 16, background: "var(--card)", borderRadius: 12 }}>
            <h1 className="text-heading-sm" style={{ marginBottom: 12 }}>Description</h1>
            <div data-loading-toolbar style={{ height: 0, overflow: "hidden", visibility: "hidden" }}><TiptapToolbarSkeleton compact /></div>
            <TiptapEditor content={content} onChange={(next) => { changeCount++; setContent(next); }} placeholder="Describe this product" ariaLabel="Description" compact />
          </section>
        </main>;
      }
      createRoot(document.getElementById("root")).render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <Fixture />
        </QueryClientProvider>
      );
    `,
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  tsconfig: resolve(app, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
});

const browser = await chromium.launch({ headless: true });
try {
  const cases = [
    ...["en", "bn"].flatMap((locale) => [390, 768, 1440].map((width) => ({ locale, width, theme: "dark" }))),
    { locale: "en", width: 1440, theme: "light" },
    { locale: "en", width: 1440, theme: "dark", cardWidth: 380 },
    { locale: "bn", width: 768, theme: "dark", touch: true },
    ...[641, 642, 643].map((cardWidth) => ({ locale: "bn", width: 1440, theme: "dark", cardWidth })),
  ];
  for (const { locale, width, theme, cardWidth = 660, touch = width < 640 } of cases) {
      const context = await browser.newContext({ offline: true, hasTouch: touch, colorScheme: theme, viewport: { width, height: 900 } });
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.setContent(`<html lang="${locale}" data-locale="${locale}" data-card-width="${cardWidth}" class="${theme === "dark" ? "dark" : ""}"><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        const editor = page.getByRole("textbox", { name: "Description", exact: true });
        await editor.waitFor();
        const fontFamily = locale === "bn" ? "Noto Sans Bengali Variable" : "Inter Variable";
        await page.evaluate(async ({ family, sample }) => {
          await document.fonts.load(`16px "${family}"`, sample);
          await document.fonts.ready;
        }, { family: fontFamily, sample: locale === "bn" ? "অনুচ্ছেদ" : "Paragraph" });
        assert.ok(await page.evaluate((family) => Array.from(document.fonts).some((font) => font.family.replace(/["']/g, "") === family && font.status === "loaded"), fontFamily), "actual dashboard font not loaded");
        const toolbar = page.getByRole("toolbar");
        const fullscreen = locale === "en" ? "Fullscreen" : "পূর্ণ স্ক্রিন";
        const bold = locale === "en" ? "Bold (Ctrl+B)" : "বোল্ড (Ctrl+B)";
        const label = `${theme}/${locale}/${width}/${cardWidth}/${touch ? "touch" : "fine"}`;
        const shotLabel = label.replaceAll("/", "-");

        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: page overflow`);
        const boxes = await toolbar.locator("button:visible").evaluateAll((nodes) => nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return { top: rect.top, left: rect.left, right: rect.right, height: rect.height, width: rect.width };
        }));
        assert.ok(Math.max(...boxes.map((box) => box.top)) - Math.min(...boxes.map((box) => box.top)) <= 4, `${label}: toolbar wraps`);
        const toolbarBox = await toolbar.boundingBox();
        for (const box of boxes) {
          assert.ok(box.left >= toolbarBox.x && box.right <= toolbarBox.x + toolbarBox.width + 1, `${label}: button outside toolbar`);
          if (touch) assert.ok(box.height >= 44 && box.width >= 44, `${label}: toolbar touch target`);
        }

        const skeletonHeight = await page.locator("[data-loading-toolbar] > div").evaluate((node) => node.getBoundingClientRect().height);
        assert.equal(skeletonHeight, toolbarBox.height, `${label}: loading toolbar shifts layout`);
        const textFits = await toolbar.locator("button:visible span").evaluateAll((nodes) => nodes.every((node) => node.scrollWidth <= node.clientWidth + 1));
        assert.ok(textFits, `${label}: toolbar text overflows its button`);

        await editor.click();
        await page.keyboard.press("ControlOrMeta+A");
        await toolbar.getByRole("button", { name: bold, exact: true }).click();
        assert.ok(await editor.locator("strong").count(), `${label}: bold command`);
        // Dropdown commands must keep the selected content and return to writing.
        const styleMenu = toolbar.getByRole("button", { name: locale === "en" ? /^Text style and alignment:/ : /^লেখার ধরন ও অবস্থান:/ });
        await styleMenu.click();
        await page.getByRole("menuitemradio", { name: locale === "en" ? "Heading 2" : "হেডিং ২", exact: true }).click();
        await editor.locator("h2 strong").waitFor();
        await page.waitForFunction(() => document.activeElement?.classList.contains("ProseMirror"));
        const before = await editor.innerHTML();
        const changesBeforeFullscreen = await page.evaluate(() => window.__changeCount());
        await editor.evaluate((node) => { window.__fixtureEditor = node; });
        if (shots) await page.screenshot({ path: `${shots}/embedded-${shotLabel}.png` });

        await toolbar.getByRole("button", { name: fullscreen, exact: true }).click();
        await page.locator('[aria-modal="true"]').waitFor();
        assert.equal(await editor.evaluate((node) => node === window.__fixtureEditor), true, `${label}: editor remounted`);
        assert.equal(await editor.innerHTML(), before, `${label}: fullscreen changed draft`);
        const rect = await editor.boundingBox();
        assert.ok(rect && rect.height >= 600, `${label}: fullscreen writing area does not fill viewport`);
        await page.keyboard.press("Tab");
        await editor.focus();
        const focus = await editor.evaluate((node) => {
          const style = getComputedStyle(node);
          const scrollport = node.closest("[data-rich-text-scrollport]");
          const outer = getComputedStyle(scrollport);
          return { outline: style.outlineStyle, width: style.outlineWidth, border: outer.borderTopColor, shadow: outer.boxShadow };
        });
        assert.ok(focus.outline === "none" || focus.width === "0px", `${label}: nested content outline`);
        assert.ok(focus.shadow.includes("inset") && focus.shadow.includes(focus.border), `${label}: toolbar divider has no keyboard focus indicator`);
        assert.equal(await page.evaluate(() => window.__changeCount()), changesBeforeFullscreen, `${label}: fullscreen emitted an edit`);
        if (shots) await page.screenshot({ path: `${shots}/fullscreen-${shotLabel}.png` });

        await styleMenu.click();
        await page.getByRole("menu").waitFor();
        await page.keyboard.press("Escape");
        await page.getByRole("menu").waitFor({ state: "detached" });
        assert.ok(await page.locator('[data-rich-text-editor][data-fullscreen]').count(), `${label}: menu Escape closed fullscreen`);
        await page.waitForFunction(() => document.activeElement?.closest("[data-rich-text-editor]"));
        await page.keyboard.press("Escape");
        await page.locator('[data-rich-text-editor][data-fullscreen]').waitFor({ state: "detached" });
        assert.equal(await editor.innerHTML(), before, `${label}: exit changed draft`);
        await page.waitForFunction(() => document.activeElement?.closest("[data-rich-text-fullscreen-toggle]"));
        await editor.focus();
        await page.keyboard.press("ControlOrMeta+Z");
        await page.waitForFunction(() => !document.querySelector(".ProseMirror h2"));
        await page.keyboard.press("ControlOrMeta+Shift+Z");
        await editor.locator("h2 strong").waitFor();
        assert.equal(await editor.innerHTML(), before, `${label}: fullscreen lost undo/redo history`);

        await page.locator('[data-sample="empty"]').click();
        await page.waitForFunction(() => document.querySelector(".ProseMirror")?.textContent === "");
        const embeddedScroll = await page.locator("[data-rich-text-scrollport]").evaluate((node) => ({ client: node.clientHeight, scroll: node.scrollHeight }));
        assert.ok(embeddedScroll.scroll <= embeddedScroll.client, `${label}: empty compact editor has a stray scrollbar`);
        if (shots) await page.screenshot({ path: `${shots}/empty-embedded-${shotLabel}.png` });
        await toolbar.getByRole("button", { name: fullscreen, exact: true }).click();
        await page.locator('[aria-modal="true"]').waitFor();
        const emptyRect = await editor.boundingBox();
        assert.ok(emptyRect && emptyRect.height >= 600, `${label}: empty fullscreen writing area`);
        await editor.focus();
        if (shots) await page.screenshot({ path: `${shots}/empty-fullscreen-${shotLabel}.png` });
        if (locale === "en") {
          const insertMenu = toolbar.getByRole("button", { name: "Insert", exact: true });
          const openInsert = async () => { await (await insertMenu.isVisible() ? insertMenu : toolbar.getByRole("button", { name: "More formatting", exact: true })).click(); };
          await openInsert();
          await page.getByRole("menuitem", { name: "Insert image URL", exact: true }).click();
          await page.getByRole("textbox", { name: "Image URL", exact: true }).waitFor();
          await page.keyboard.press("Escape");
          assert.ok(await page.locator('[data-rich-text-editor][data-fullscreen]').count(), `${label}: panel Escape closed fullscreen`);
          await openInsert();
          await page.getByRole("menuitem", { name: "Insert table", exact: true }).click();
          await page.getByRole("button", { name: "Insert table", exact: true }).click();
          await editor.locator("table").waitFor();
          await page.waitForFunction(() => document.activeElement?.classList.contains("ProseMirror"));
          await page.emulateMedia({ forcedColors: "active" });
          const forcedFocus = await editor.evaluate((node) => ({ style: getComputedStyle(node).outlineStyle, width: getComputedStyle(node).outlineWidth }));
          assert.equal(forcedFocus.style, "solid", `${label}: forced-color focus indicator`);
          assert.equal(forcedFocus.width, "2px", `${label}: forced-color focus thickness`);
          await page.emulateMedia({ forcedColors: "none" });
        }
        await page.keyboard.press("Escape");

        await page.locator('[data-sample="long"]').click();
        await page.waitForFunction(() => document.querySelector(".ProseMirror")?.textContent?.includes("Paragraph 30"));
        await toolbar.getByRole("button", { name: fullscreen, exact: true }).click();
        await page.locator('[aria-modal="true"]').waitFor();
        await editor.locator("p").last().scrollIntoViewIfNeeded();
        const scroll = await editor.locator("p").last().evaluate((node) => {
          const last = node.getBoundingClientRect();
          for (let parent = node.parentElement; parent; parent = parent.parentElement) {
            if (!/(auto|scroll)/.test(getComputedStyle(parent).overflowY) || parent.scrollHeight <= parent.clientHeight) continue;
            const viewport = parent.getBoundingClientRect();
            return { top: last.top, bottom: last.bottom, viewportTop: viewport.top, viewportBottom: Math.min(viewport.bottom, innerHeight), scrollTop: parent.scrollTop };
          }
          return null;
        });
        assert.ok(scroll && scroll.scrollTop > 0 && scroll.top >= scroll.viewportTop - 1 && scroll.bottom <= scroll.viewportBottom + 1, `${label}: last paragraph is outside the editing scrollport`);
        assert.equal(errors.length, 0, `${label}: browser errors: ${errors.join("; ")}`);
        console.log(`Offline rich text: ${label} OK`);
      } finally {
        await context.close();
      }
  }
} finally {
  await browser.close();
}
