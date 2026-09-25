// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression: product pages used to ship the complete stylesheet as
// `media="print, (min-width: 40rem)"` and swap it in after window load, with a
// hand-picked inline "critical" sheet covering only the classic header. Every
// other header, drawer and template rendered as raw HTML on phones until the
// load event, and rotating a phone to landscape dropped every style (neither
// media query matched). The shared stylesheet must be an ordinary
// render-blocking link on every page, and nothing may rewrite it.
const SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(astro|ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("shared stylesheet delivery", () => {
  const files = sourceFiles(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

  it("never rewrites stylesheet links in responses", () => {
    const rewriters = files.filter(({ text }) =>
      /\.on\(\s*['"`]link\[rel=["']?stylesheet/.test(text),
    );
    expect(rewriters.map(({ path }) => path.slice(SRC.length))).toEqual([]);
  });

  it("never defers a stylesheet behind a print or swapped media query", () => {
    const deferred = files.filter(({ text }) =>
      /media=["'{][^"'}]*print|this\.media\s*=/.test(text),
    );
    expect(deferred.map(({ path }) => path.slice(SRC.length))).toEqual([]);
  });

  it("does not inline a partial page-specific stylesheet in place of the shared sheet", () => {
    const inlined = files.filter(({ text }) => /\.css\?inline["']/.test(text));
    expect(inlined.map(({ path }) => path.slice(SRC.length))).toEqual([]);
  });
});
