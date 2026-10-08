// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appProxyUrl,
  applyAppMessage,
  applyAppPressed,
  loadAppStates,
  readAppFormAnswer,
  sameOriginPath,
} from "./app-forms";

const ORIGIN = "https://shop.test";

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("app forms enhancer guards", () => {
  it("posts only to this store's /apps/ proxy", () => {
    expect(appProxyUrl("/apps/acme.wishlist/toggle", ORIGIN)).toBe("https://shop.test/apps/acme.wishlist/toggle");
    expect(appProxyUrl("https://shop.test/apps/acme.wishlist/state?productId=p1", ORIGIN))
      .toBe("https://shop.test/apps/acme.wishlist/state?productId=p1");
    for (const value of [
      "https://evil.example/apps/x.y/toggle",
      "//evil.example/apps/x.y/toggle",
      "/account",
      "/apps/",
      "/apps/x.y",
      "/apps/x.y/../../account",
      "/apps/x.y/%2e%2e/admin",
      "javascript:alert(1)",
      "",
      null,
      42,
    ]) {
      expect(appProxyUrl(value, ORIGIN), String(value)).toBeNull();
    }
  });

  it("follows navigate and redirect only to a path on this store", () => {
    expect(sameOriginPath("/account", ORIGIN)).toBe("/account");
    expect(sameOriginPath("/products/linen?x=1#top", ORIGIN)).toBe("/products/linen?x=1#top");
    for (const value of ["//evil.example", "/\\evil.example", "https://evil.example/", "javascript:alert(1)", "account", "/a\nb", "/a\\b", undefined]) {
      expect(sameOriginPath(value, ORIGIN), String(value)).toBeNull();
    }
  });

  it("reads only the contract's fields from an answer", () => {
    expect(readAppFormAnswer({ pressed: true, message: " Saved. ", navigate: "/x", extra: "<b>" })).toEqual({ pressed: true, message: "Saved.", navigate: "/x" });
    expect(readAppFormAnswer({ pressed: "yes", message: 4 })).toEqual({});
    expect(readAppFormAnswer({ success: false, error: { message: "The app could not be reached." } })).toEqual({ message: "The app could not be reached." });
    expect(readAppFormAnswer("x".repeat(10))).toEqual({});
    expect(readAppFormAnswer({ message: "m".repeat(1000) }).message).toHaveLength(300);
  });
});

function wishlistForm(): HTMLFormElement {
  document.body.innerHTML = [
    '<form action="/apps/acme.wishlist/toggle" method="post" data-app-form data-app-state="/apps/acme.wishlist/state?productId=p1">',
    '<button type="submit" aria-pressed="false" data-app-label-on="Saved" data-app-label-off="Save"><span data-app-label>Save</span></button>',
    '<p role="status" data-app-message></p>',
    "</form>",
  ].join("");
  return document.querySelector("form")!;
}

describe("app forms enhancer DOM updates", () => {
  it("sets the pressed state and swaps the label as text", () => {
    const form = wishlistForm();
    applyAppPressed(form, true);
    const button = form.querySelector("button")!;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(form.querySelector("[data-app-label]")!.textContent).toBe("Saved");
    applyAppPressed(form, false);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(form.querySelector("[data-app-label]")!.textContent).toBe("Save");
  });

  it("puts a message into the status region as text, never as HTML", () => {
    const form = wishlistForm();
    applyAppMessage(form, '<img src=x onerror="alert(1)">');
    const region = form.querySelector("[data-app-message]")!;
    expect(region.textContent).toBe('<img src=x onerror="alert(1)">');
    expect(region.querySelector("img")).toBeNull();
  });

  it("reads each state URL once and applies pressed", async () => {
    const form = wishlistForm();
    document.body.insertAdjacentHTML("beforeend", form.outerHTML.replace("<form", '<form id="second"'));
    document.body.insertAdjacentHTML("beforeend", '<div data-app-state="https://evil.example/apps/x.y/state"><button aria-pressed="false"></button></div>');
    const fetch = vi.fn(async (input: string) => new Response(JSON.stringify({ pressed: input.includes("p1") }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    await loadAppStates(document);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(`${window.location.origin}/apps/acme.wishlist/state?productId=p1`);
    for (const each of Array.from(document.querySelectorAll("form"))) {
      expect(each.querySelector("button")!.getAttribute("aria-pressed")).toBe("true");
    }
    expect(document.querySelector("div[data-app-state] button")!.getAttribute("aria-pressed")).toBe("false");
  });
});
