// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { stackGapFindings } from "./analysis.mjs";
import { collectFacts } from "./page-facts.mjs";

function render(markup) {
  document.body.innerHTML = markup;
  for (const element of document.body.querySelectorAll("*")) {
    element.style.opacity = "1";
    const top = Number(element.dataset.top ?? 0);
    const height = Number(element.dataset.height ?? 0);
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      x: 0, y: top, left: 0, right: 300, top, bottom: top + height, width: 300, height,
      toJSON: () => ({}),
    });
  }
}

function listField(noteSlot, gap) {
  render(`
    <div data-slot="field">
      <div id="group" data-slot="field-control" data-height="120">
        <input id="first" aria-describedby="note" data-height="36">
        <input id="last" aria-describedby="note" data-top="44" data-height="36">
        <button data-top="88" data-height="32">Add item</button>
      </div>
      <p id="note" data-slot="${noteSlot}" data-top="${120 + gap}" data-height="20">Shared note</p>
    </div>
  `);
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("help gap collection", () => {
  it.each(["field-help", "field-error"])("measures one whole list group for its %s at 4px", (slot) => {
    listField(slot, 4);
    const pairs = collectFacts().gapPairs.filter((pair) => pair.kind === "help");
    expect(pairs).toHaveLength(1);
    expect(pairs[0].above.bottom).toBe(120);
    expect(stackGapFindings(pairs).help).toEqual([]);
  });

  it.each(["field-help", "field-error"])("still flags its own %s at 8px below the group", (slot) => {
    listField(slot, 8);
    const pairs = collectFacts().gapPairs.filter((pair) => pair.kind === "help");
    expect(pairs).toHaveLength(1);
    expect(stackGapFindings(pairs).help).toEqual(["div#group (8px above its help)"]);
  });

  it("still measures an ungrouped control's 8px gap", () => {
    render('<input id="single" aria-describedby="note" data-height="36"><p id="note" data-top="44" data-height="20">Help</p>');
    expect(stackGapFindings(collectFacts().gapPairs).help).toEqual(["input#single (8px above its help)"]);
  });

  it("retains the individual control boundary for a description outside its Field", () => {
    render(`
      <div data-slot="field">
        <div id="group" data-slot="field-control" data-height="120">
          <input id="external-control" aria-describedby="external" data-top="44" data-height="36">
        </div>
      </div>
      <p id="external" data-slot="field-help" data-top="88" data-height="20">External help</p>
    `);
    expect(stackGapFindings(collectFacts().gapPairs).help).toEqual(["input#external-control (8px above its help)"]);
  });
});
