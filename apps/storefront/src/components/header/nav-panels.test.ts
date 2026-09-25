// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { applyNavPanels } from "./nav-panels";

describe("menu panels filled on intent", () => {
  it("swaps each closed panel's contents for the whole one, matched by key", () => {
    document.body.innerHTML = `
      <nav id="desktop-nav" data-nav-panels="/navigation/panels">
        <ul data-nav-overflow>
          <li data-nav-index="0" data-nav-key="/categories/laptop">
            <a href="/categories/laptop">Laptop</a>
            <div id="p0" class="mega-panel" hidden><div class="mega-body"><a href="/categories/gaming">Gaming</a></div></div>
          </li>
          <li data-nav-index="1" data-nav-key="/categories/phone">
            <a href="/categories/phone">Phone</a>
            <details><summary>Phone</summary><div class="cnav-panel" data-menu-panel><a href="/categories/android">Android</a></div></details>
          </li>
          <li data-nav-index="2" data-nav-key="/categories/tv">
            <a href="/categories/tv">TV</a>
            <div id="p2" class="desktop-nav-dropdown"><a id="focused" href="/categories/oled">OLED</a></div>
          </li>
        </ul>
      </nav>`;
    const nav = document.getElementById("desktop-nav")!;
    document.getElementById("focused")!.focus();
    const filled = applyNavPanels(
      nav,
      `<template data-panel-for="/categories/laptop"><div class="mega-panel"><div class="mega-body">${
        ["gaming", "business", "ultrabook"].map((slug) => `<a href="/categories/${slug}">${slug}</a>`).join("")
      }</div><div class="mega-foot"><a href="/categories/laptop">View all Laptop</a></div></div></template>
       <template data-panel-for="/categories/phone"><div class="cnav-panel" data-menu-panel><a href="/categories/android">Android</a><a href="/categories/iphone">iPhone</a></div></template>
       <template data-panel-for="/categories/tv"><div class="desktop-nav-dropdown"><a href="/categories/oled">OLED</a><a href="/categories/qled">QLED</a></div></template>
       <template data-panel-for="/categories/gone"><div class="desktop-nav-dropdown"><a href="/x">X</a></div></template>`,
    );
    // Laptop and Phone are filled; TV keeps the links the buyer is on.
    expect(filled).toBe(2);
    const laptop = document.getElementById("p0")!;
    expect(laptop.hidden).toBe(true);
    expect(laptop.querySelectorAll("a")).toHaveLength(4);
    expect(nav.querySelectorAll('[data-nav-index="1"] [data-menu-panel] a')).toHaveLength(2);
    expect(document.getElementById("p2")!.querySelectorAll("a")).toHaveLength(1);
    expect(nav.hasAttribute("data-nav-panels-filled")).toBe(true);
  });
});
