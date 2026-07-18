import { describe, expect, it } from "vitest";

import { defaultFooterConfig } from "../footer-builder/types";
import { defaultHeaderConfig } from "../header-builder/types";
import { rebaseFooterDraft, rebaseHeaderDraft } from "./presentation-draft";

describe("presentation settings draft rebasing", () => {
  it("keeps local header leaves while adopting unrelated newer fields", () => {
    const base = {
      ...defaultHeaderConfig,
      logo: { src: "/old.svg", alt: "Old" },
      contact: { phone: "1", text: "Call", isEnabled: true },
    };
    const local = {
      ...base,
      logo: { ...base.logo, alt: "Local alt" },
    };
    const latest = {
      ...base,
      logo: { src: "/new.svg", alt: "Elsewhere" },
      contact: { phone: "2", text: "Support", isEnabled: true },
    };

    expect(rebaseHeaderDraft(base, local, latest)).toMatchObject({
      logo: { src: "/new.svg", alt: "Local alt" },
      contact: latest.contact,
    });
  });

  it("treats reordered footer menus as one intentional local structure", () => {
    const first = { id: "first", title: "First", links: [] };
    const second = { id: "second", title: "Second", links: [] };
    const base = { ...defaultFooterConfig, menus: [first, second] };
    const local = { ...base, menus: [second, first] };
    const latest = { ...base, tagline: "Latest", social: [{ id: "x", label: "X", url: "https://x.com" }] };

    expect(rebaseFooterDraft(base, local, latest)).toMatchObject({
      menus: [second, first],
      tagline: "Latest",
      social: latest.social,
    });
  });
});
