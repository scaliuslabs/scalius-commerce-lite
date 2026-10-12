import { describe, expect, it } from "vitest";
import { defineStorefront } from "./define";
import { raw } from "./html";
import { assertHeaderContract, renderHeader } from "./testing";

describe("header render assertions", () => {
  it("identifies the failing component and its markup error", () => {
    const module = defineStorefront({ slots: { masthead: () => raw('<header id="menu"><nav id="menu"></nav></header>') } });
    expect(() => renderHeader(module, "masthead")).toThrow('Header "masthead": Invalid header markup: Duplicate id "menu"');
  });

  it("checks explicit island declarations without requiring optional header features", () => {
    const module = defineStorefront({ slots: {
      campaign: () => raw('<a href="/">Shop</a>'),
      menu: () => raw('<scalius-island data-island="menu"></scalius-island>'),
    } });
    expect(renderHeader(module, "campaign", {}, {}, { islands: [] })).toBe('<a href="/">Shop</a>');
    expect(() => renderHeader(module, "menu", {}, {}, { islands: [] })).toThrow('Island "menu" is not declared');
    expect(() => renderHeader(module, "menu", {}, {}, { islands: ["menu"] })).not.toThrow();
    expect(() => assertHeaderContract('<header data-sticky-header>Shop</header>')).not.toThrow();
  });
});
