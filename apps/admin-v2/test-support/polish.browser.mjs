// Offline geometry/focus regression: build admin-v2 first, then run this file
// from the repo root. No server, API, cookies, or external resources are used.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const app = resolve("apps/admin-v2");
const assets = resolve(app, "dist/assets/immutable");
const css = (await Promise.all((await readdir(assets)).filter((name) => name.endsWith(".css")).map((name) => readFile(resolve(assets, name), "utf8")))).join("\n");
const bundle = await build({
  stdin: {
    resolveDir: app,
    loader: "tsx",
    contents: `
      import React, { useState } from "react";
      import { createRoot } from "react-dom/client";
      import { Button, buttonVariants } from "./src/components/ui/button";
      import { Badge } from "./src/components/ui/badge";
      import { Checkbox } from "./src/components/ui/checkbox";
      import { RadioGroup, RadioGroupItem } from "./src/components/ui/radio-group";
      import { Switch } from "./src/components/ui/switch";
      import { Table, TableBody, TableRow, TableCell } from "./src/components/ui/table";
      import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./src/components/ui/dialog";
      import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "./src/components/ui/dropdown-menu";
      function Fixture() {
        const [open, setOpen] = useState(false);
        return <main className="space-y-4 p-4 text-body">
          <div className="flex flex-wrap gap-4">
            {["default", "sm", "lg", "icon", "icon-sm"].map(size => <Button key={size} size={size} data-target={size}>{size.startsWith("icon") ? "+" : "Action"}</Button>)}
          </div>
          <div className="flex flex-wrap gap-4">
            <Button variant="destructive" data-target="destructive">Delete</Button>
            <Button asChild><a href="#" data-target="button-link">Open</a></Button>
            <button className={buttonVariants({ variant: "destructive" })} data-target="button-variants">Confirm</button>
          </div>
          <div className="overflow-hidden"><div tabIndex={0} id="clipped-focus" className="h-16 overflow-auto">Scrollable region</div></div>
          <div className="flex items-center gap-8 p-4">
            <Checkbox aria-label="Select" data-target="checkbox" />
            <RadioGroup><RadioGroupItem value="one" aria-label="Choice" data-target="radio" /></RadioGroup>
            <Switch aria-label="Enabled" data-target="switch" />
            <Badge>Value<Button variant="ghost" size="icon-sm" aria-label="Remove Value" data-target="remove">×</Button></Badge>
          </div>
          <Table><TableBody>
            {["Short", "A long product title with words that need two lines"].map(name => <TableRow density="default" key={name}><TableCell><a href="#" title={name} className="line-clamp-2 max-w-40" data-target="table-link">{name}</a></TableCell></TableRow>)}
          </TableBody></Table>
          <Button id="dialog-opener" onClick={() => setOpen(true)}>Import</Button>
          <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogTitle>Import</DialogTitle><DialogDescription>Choose a file.</DialogDescription><Button>Choose</Button></DialogContent></Dialog>
          <DropdownMenu><DropdownMenuTrigger asChild><Button id="menu-opener">Actions</Button></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>View</DropdownMenuItem><DropdownMenuItem>Edit</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        </main>;
      }
      createRoot(document.getElementById("root")).render(<Fixture />);
    `,
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
  tsconfig: resolve(app, "tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"' },
});

function contrast(first, second) {
  const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3)
    .map((part) => Number(part) / 255)
    .map((part) => part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4)
    .reduce((sum, part, index) => sum + part * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ offline: true });
  await context.route("**/*", (route) => route.abort());
  const page = await context.newPage();
  for (const locale of ["en", "bn"]) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(`<html lang="${locale}"><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.locator("[data-target]").first().waitFor();
      const boxes = await page.locator("[data-target]").evaluateAll((nodes) => nodes.map((node) => ({ name: node.getAttribute("data-target"), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })));
      for (const box of boxes) {
        assert.ok(box.width >= 24 && box.height >= (width < 640 ? 44 : 24), `${locale}/${width} ${JSON.stringify(box)}`);
      }
      const rows = await page.locator("tbody tr").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
      assert.ok(Math.max(...rows) - Math.min(...rows) <= 1, `Row heights ${locale}/${width}: ${rows}`);
      assert.equal(await page.locator("[data-target=table-link]").first().evaluate((node) => getComputedStyle(node).webkitLineClamp), "2");
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
        await page.keyboard.press("Tab");
        for (const target of ["default", "destructive", "button-link", "button-variants"]) {
          const button = page.locator(`[data-target=${target}]`);
          await button.focus();
          const style = await button.evaluate((node) => {
            const style = getComputedStyle(node);
            return { focused: node.matches(":focus-visible"), shadow: style.boxShadow, outline: style.outlineStyle,
              width: style.outlineWidth, offset: style.outlineOffset, color: style.outlineColor };
          });
          const label = `${locale}/${width}/${theme}/${target}`;
          assert.ok(style.focused, `${label}: keyboard focus`);
          assert.equal(style.outline, "solid", `${label}: native focus outline`);
          assert.equal(style.width, "2px", `${label}: 2px focus outline`);
          assert.equal(style.offset, "1px", `${label}: 1px contrasting gap`);
          const shadows = (style.shadow.match(/rgba?\([^)]+\)[^,]*/g) ?? [])
            .map((shadow) => shadow.trim().match(/^(rgba?\([^)]+\)) 0px 0px 0px ([\d.]+)px$/))
            .filter(Boolean);
          const offset = shadows.find((shadow) => Number(shadow[2]) === 1);
          assert.ok(offset, `${label}: gap separates outline from button fill: ${style.shadow}`);
          assert.ok(contrast(style.color, offset[1]) >= 3, `${label}: focus ring contrast`);
        }
        await page.locator("#clipped-focus").focus();
        const fallback = await page.locator("#clipped-focus").evaluate((node) => {
          const style = getComputedStyle(node);
          return { width: style.outlineWidth, offset: style.outlineOffset, color: style.outlineColor };
        });
        assert.equal(fallback.width, "2px");
        assert.equal(fallback.offset, "-2px");
        assert.notEqual(fallback.color, "rgba(0, 0, 0, 0)");
      }
      await page.evaluate(() => document.documentElement.classList.remove("dark"));
      await page.emulateMedia({ forcedColors: "active" });
      for (const target of ["default", "destructive", "button-link", "button-variants"]) {
        const button = page.locator(`[data-target=${target}]`);
        await button.focus();
        const outline = await button.evaluate((node) => {
          const style = getComputedStyle(node);
          return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
        });
        assert.equal(outline.style, "solid", `${target}: forced-colors outline`);
        assert.equal(outline.width, "2px");
        assert.notEqual(outline.color, "rgba(0, 0, 0, 0)");
      }
      await page.emulateMedia({ forcedColors: "none" });
      for (const [trigger, surface] of [["#dialog-opener", "[role=dialog]"], ["#menu-opener", "[role=menu]"]]) {
        await page.locator(trigger).click();
        await page.locator(surface).waitFor();
        const hidden = await page.locator('[data-aria-hidden="true"]').evaluateAll((nodes) => nodes.every((node) => node.inert));
        assert.ok(hidden, `${surface} background must be inert`);
        await page.keyboard.press("Escape");
        await page.locator(surface).waitFor({ state: "detached" });
        await page.waitForFunction((selector) => document.activeElement === document.querySelector(selector), trigger);
      }
      console.log(`Offline polish geometry and focus: ${width}px ${locale} OK`);
    }
  }
} finally {
  await browser.close();
}
