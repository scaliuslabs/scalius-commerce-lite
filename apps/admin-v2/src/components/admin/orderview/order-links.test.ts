import { describe, expect, it } from "vitest";
import { customerContactLinks } from "./contact-links";
import { findOrderNeighbours } from "./order-neighbours";

describe("customer contact links", () => {
  it.each([
    ["01712-345 678", "https://wa.me/8801712345678"],
    ["+8801712345678", "https://wa.me/8801712345678"],
    ["1712345678", "https://wa.me/8801712345678"],
  ])("normalises %s for WhatsApp", (phone, whatsapp) => {
    expect(customerContactLinks(phone).whatsapp).toBe(whatsapp);
  });

  it("keeps call and SMS links dialable", () => {
    expect(customerContactLinks("+880 1712-345678")).toMatchObject({
      call: "tel:+8801712345678",
      sms: "sms:+8801712345678",
    });
    expect(customerContactLinks("12").whatsapp).toBeNull();
  });
});

describe("order neighbours", () => {
  const pages = [
    { updatedAt: 1, ids: ["a", "b", "c"] },
    { updatedAt: 2, ids: ["x", "b", "y"] },
  ];

  it("uses the most recently fetched page that contains the order", () => {
    expect(findOrderNeighbours(pages, "b")).toEqual({ previous: "x", next: "y" });
  });

  it("marks the ends of a page", () => {
    expect(findOrderNeighbours(pages, "a")).toEqual({ previous: null, next: "b" });
    expect(findOrderNeighbours(pages, "y")).toEqual({ previous: "b", next: null });
  });

  it("hides navigation for orders that aren't in a cached list", () => {
    expect(findOrderNeighbours(pages, "deep-link")).toBeNull();
  });
});
