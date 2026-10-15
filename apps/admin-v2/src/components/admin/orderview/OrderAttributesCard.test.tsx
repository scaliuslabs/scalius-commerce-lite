// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { setLocale } from "~/i18n";
import { OrderAttributesCard } from "./OrderAttributesCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("groups answers by the complete app id, renders buyer text safely and omits empty cards", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() => root.render(<OrderAttributesCard attributes={{
      "acme.notes.message": "<script>buyer text</script>\nSecond line",
      "acme.notes.gift": "true",
      "acme.loyalty.points": "50",
    }} />));
    const groups = [...container.querySelectorAll("section")];
    expect(groups.map((section) => section.querySelector("h3")?.textContent)).toEqual(["acme.notes", "acme.loyalty"]);
    expect(groups[0]?.querySelectorAll("dt")).toHaveLength(2);
    expect(groups[0]?.querySelector("dd")?.textContent).toBe("<script>buyer text</script>\nSecond line");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("App details");

    act(() => setLocale("bn"));
    expect(container.textContent).toContain("অ্যাপের তথ্য");
    act(() => root.render(<OrderAttributesCard attributes={{}} />));
    expect(container.innerHTML).toBe("");
    act(() => root.render(<OrderAttributesCard />));
    expect(container.innerHTML).toBe("");
  } finally {
    act(() => root.unmount());
    setLocale("en");
  }
});
