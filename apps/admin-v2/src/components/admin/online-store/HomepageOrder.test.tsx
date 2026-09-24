// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { storefrontStylePresetTheme, type StorefrontSection } from "@scalius/shared/storefront-theme";
import { HomepageOrder } from "./ThemeChoices";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLASSIC = storefrontStylePresetTheme("classic").sections;
const STORY: StorefrontSection = {
  id: "story",
  type: "rich_text",
  version: 1,
  settings: { heading: "Our story", body: "Handmade in Dhaka." },
};

function render(initial: StorefrontSection[] = CLASSIC) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const seen: { sections: StorefrontSection[] } = { sections: [] };
  function Page() {
    const [sections, setSections] = useState(initial);
    seen.sections = sections;
    return <HomepageOrder sections={sections} onChange={setSections} />;
  }
  act(() => root.render(<Page />));
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const names = () => [...container.querySelectorAll("li")].map((row) => row.firstElementChild?.textContent);
  const ids = () => seen.sections.map((section) => section.id);
  return { seen, ids, button, names, unmount: () => act(() => root.unmount()) };
}

describe("homepage section order", () => {
  it("moves a section with its buttons; the ends cannot move further", () => {
    const view = render();
    expect(view.names()).toEqual(["Banners", "Collections", "Featured categories", "Delivery and returns"]);
    expect(view.button("Move Banners up").disabled).toBe(true);
    expect(view.button("Move Delivery and returns down").disabled).toBe(true);

    act(() => view.button("Move Featured categories up").click());
    expect(view.ids()).toEqual(["hero", "categories", "collections", "delivery"]);
    expect(view.names()).toEqual(["Banners", "Featured categories", "Collections", "Delivery and returns"]);
    view.unmount();
  });

  it("keeps keyboard focus on the moved section, switching buttons when it reaches an end", () => {
    const view = render();
    view.button("Move Collections up").focus();
    act(() => view.button("Move Collections up").click());
    // Collections is now first, so "up" is disabled: focus lands on its "down".
    expect(view.ids()[0]).toBe("collections");
    expect(document.activeElement).toBe(view.button("Move Collections down"));

    act(() => view.button("Move Collections down").click());
    expect(view.ids()[1]).toBe("collections");
    expect(document.activeElement).toBe(view.button("Move Collections down"));
    view.unmount();
  });

  it("lists a builder section as a custom section that moves but is never edited or removed here", () => {
    const view = render([CLASSIC[0]!, STORY, ...CLASSIC.slice(1)]);
    expect(view.names()).toEqual([
      "Banners",
      "Custom section (edit in builder)",
      "Collections",
      "Featured categories",
      "Delivery and returns",
    ]);
    const row = [...document.querySelectorAll("li")][1]!;
    // Only Move up and Move down: no edit or remove.
    expect([...row.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual([
      "Move Custom section (edit in builder) up",
      "Move Custom section (edit in builder) down",
    ]);

    act(() => view.button("Move Custom section (edit in builder) down").click());
    act(() => view.button("Move Custom section (edit in builder) down").click());
    expect(view.ids()).toEqual(["hero", "collections", "categories", "story", "delivery"]);
    // The section itself is untouched.
    expect(view.seen.sections[3]).toEqual(STORY);
    view.unmount();
  });
});
