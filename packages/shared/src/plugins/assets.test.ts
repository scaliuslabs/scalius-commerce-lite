import { describe, expect, it } from "vitest";
import { checkPluginAsset, checkPluginSvg } from "./assets";

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`;
const bytes = (text: string) => new TextEncoder().encode(text);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

/** A repository file's bytes (tests only; a runtime specifier keeps Node types out of this Workers package). */
async function readRepoFile(path: string): Promise<Uint8Array> {
  const specifier = "node:fs/promises";
  const fs = (await import(/* @vite-ignore */ specifier)) as { readFile(path: URL): Promise<Uint8Array> };
  return new Uint8Array(await fs.readFile(new URL(`../../../../${path}`, import.meta.url)));
}

describe("plugin listing images", () => {
  it("accepts drawing SVGs, internal references and plain styles", () => {
    expect(checkPluginSvg(`<?xml version="1.0"?>${svg('<defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect fill="url(#g)" width="10" height="10"/><use href="#g"/>')}`)).toBeNull();
    expect(checkPluginSvg(svg("<style>.a{fill:#e2136e}</style><path class=\"a\" d=\"M0 0h10v10z\"/>"))).toBeNull();
  });

  it.each([
    ["a script", svg("<script>alert(1)</script>")],
    ["an event handler", svg('<rect onload="alert(1)"/>')],
    ["an outside link", svg('<use href="https://evil.example/x.svg#a"/>')],
    ["an xlink to javascript", svg('<a xlink:href="javascript:alert(1)"><rect/></a>')],
    ["foreign HTML", svg("<foreignObject><div/></foreignObject>")],
    ["an outside image", svg('<image href="https://evil.example/x.png"/>')],
    ["a style import", svg("<style>@import url(https://evil.example/x.css);</style>")],
    ["a style url", svg('<rect style="fill:url(https://evil.example/x)"/>')],
    ["an entity", `<!DOCTYPE svg [<!ENTITY x "y">]>${svg("")}`],
    ["HTML", "<html><body>hi</body></html>"],
  ])("refuses %s", (_label, text) => {
    expect(checkPluginSvg(text)).not.toBeNull();
  });

  it("checks type, size and content of each file", () => {
    expect(checkPluginAsset("icon.png", PNG, "icon")).toBeNull();
    expect(checkPluginAsset("icon.png", bytes("not a png"), "icon")).toMatch(/not a image\/png/);
    expect(checkPluginAsset("icon.svg", bytes(svg("<script/>")), "icon")).toMatch(/<script>/);
    expect(checkPluginAsset("icon.svg", new Uint8Array(70 * 1024), "icon")).toMatch(/limit/);
    expect(checkPluginAsset("shot.svg", bytes(svg("")), "screenshot")).toMatch(/must be/);
    expect(checkPluginAsset("shot.png", new Uint8Array(0), "screenshot")).toMatch(/empty/);
  });

  it("passes the first-party payment logos", async () => {
    for (const plugin of ["bkash", "nagad"]) {
      expect(checkPluginAsset("assets/icon.svg", await readRepoFile(`plugins/${plugin}/assets/icon.svg`), "icon"), plugin).toBeNull();
    }
  });
});
