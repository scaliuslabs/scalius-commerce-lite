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
      import { Button } from "./src/components/ui/button";
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
