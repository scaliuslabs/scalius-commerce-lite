import { describe, expect, it } from "vitest";
import { placeTrackOrderLink } from "./footer-links";

const menu = (title: string, hrefs: string[] = []) => ({
  id: title,
  title,
  links: hrefs.map((href) => ({ title: href, href })),
});

describe("footer track-order link", () => {
  it("moves the one link into the Help column", () => {
    const { menus, inBottomRow } = placeTrackOrderLink([menu("Shop", ["/categories/tea"]), menu("Help", ["/contact"])], "Track your order");
    expect(inBottomRow).toBe(false);
    expect(menus[0]!.links).toHaveLength(1);
    expect(menus[1]!.links.at(-1)).toEqual({ title: "Track your order", href: "/track-order" });
  });

  it("finds Help columns by their usual names, in English and Bangla", () => {
    for (const title of ["help", "Help & FAQ", "Customer service", "Support", "সাহায্য"]) {
      expect(placeTrackOrderLink([menu(title)], "Track your order").inBottomRow).toBe(false);
    }
    expect(placeTrackOrderLink([menu("Helpful links")], "Track your order").inBottomRow).toBe(true);
  });

  it("keeps it in the bottom row when there is no Help column", () => {
    const menus = [menu("Shop"), menu("About")];
    expect(placeTrackOrderLink(menus, "Track your order")).toEqual({ menus, inBottomRow: true });
  });

  it("adds nothing when a menu already links track order", () => {
    const menus = [menu("Help", ["/contact"]), menu("Orders", ["/track-order?order=1001"])];
    expect(placeTrackOrderLink(menus, "Track your order")).toEqual({ menus, inBottomRow: false });
  });
});
