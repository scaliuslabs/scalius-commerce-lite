// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADDRESS_AUTOCOMPLETE_DEBOUNCE_MS,
  autocompleteCountry,
  autocompleteQuery,
  enhanceAddressAutocomplete,
  newSessionToken,
  readResolvedAddress,
  readSuggestions,
  type AddressAutocomplete,
} from "./address-autocomplete";

const service = { id: "acme.addresses/lookup", countries: ["GB", "AE"] as string[] };

const SUGGESTIONS = {
  success: true,
  data: {
    suggestions: [
      { id: "s1", text: "10 Downing Street", secondaryText: "London SW1A 2AA" },
      { id: "s2", text: "10 Downing Place", secondaryText: "Cambridge CB2 3NY" },
    ],
  },
};
const ADDRESS = {
  success: true,
  data: { address: { countryCode: "GB", line1: "10 Downing Street", dependentLocality: "Westminster", locality: "London", adminArea: "England", postalCode: "SW1A 2AA" } },
};

function page(country = "GB") {
  document.body.innerHTML = `<form id="checkoutForm">
    <select name="shippingCountryCode"><option value="BD">Bangladesh</option><option value="GB">United Kingdom</option><option value="AE">UAE</option><option value="US">United States</option></select>
    <div>
      <label for="shippingAddress">Delivery address</label>
      <textarea id="shippingAddress" name="shippingAddress" maxlength="500"></textarea>
    </div>
    <div data-address-rule="line2"><input name="shippingAddressLine2" maxlength="200" /></div>
    <div data-address-rule="dependentLocality"><input name="shippingDependentLocality" maxlength="120" /></div>
    <div data-address-rule="locality"><input name="shippingLocality" maxlength="120" /></div>
    <div data-address-rule="adminArea" id="admin-wrapper"><input name="shippingAdminArea" maxlength="120" /></div>
    <div data-address-rule="postalCode"><input name="shippingPostalCode" maxlength="20" /></div>
  </form>`;
  const select = document.querySelector<HTMLSelectElement>("select")!;
  select.value = country;
  const input = document.getElementById("shippingAddress") as HTMLTextAreaElement;
  input.focus();
  return { form: document.getElementById("checkoutForm")!, select, input };
}

const field = (name: string) => document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;

function start(overrides: Partial<Parameters<typeof enhanceAddressAutocomplete>[0]> & { post?: ReturnType<typeof vi.fn> } = {}, country = "GB") {
  const { form, select, input } = page(country);
  const post = overrides.post ?? vi.fn(async (path: string) => (path.endsWith("/suggest") ? SUGGESTIONS : ADDRESS));
  const box: AddressAutocomplete = enhanceAddressAutocomplete({
    root: form,
    input,
    service,
    locale: "en",
    post,
    ...overrides,
  });
  return { form, select, input, post, box };
}

const type = (input: HTMLTextAreaElement, text: string) => {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};
const key = (target: HTMLElement, name: string) => {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
};
const settle = async () => {
  await vi.advanceTimersByTimeAsync(ADDRESS_AUTOCOMPLETE_DEBOUNCE_MS);
};
const options = () => Array.from(document.querySelectorAll("[role=option]"));
const listbox = () => document.querySelector<HTMLElement>("[role=listbox]")!;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("address autocomplete: pure rules", () => {
  it("needs three characters of one tidy line, at most 200", () => {
    expect(autocompleteQuery("ab")).toBeNull();
    expect(autocompleteQuery("  10   Down  \n St ")).toBe("10 Down St");
    expect(autocompleteQuery("x".repeat(500))).toHaveLength(200);
  });

  it("serves only countries the app lists, never Bangladesh", () => {
    const { form, select } = page("GB");
    expect(autocompleteCountry(form, service)).toBe("GB");
    select.value = "US";
    expect(autocompleteCountry(form, service)).toBeNull();
    select.value = "BD";
    expect(autocompleteCountry(form, { id: "x/y", countries: "any" })).toBeNull();
    select.value = "US";
    expect(autocompleteCountry(form, { id: "x/y", countries: "any" })).toBe("US");
  });

  it("makes a 32 character base64url session token each time", () => {
    const first = newSessionToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newSessionToken()).not.toBe(first);
  });

  it("reads only well-formed answers", () => {
    expect(readSuggestions({ success: true, data: { suggestions: [{ id: "a", text: " One " }, { id: "", text: "x" }, { text: "y" }, null] } })).toEqual([{ id: "a", text: "One" }]);
    expect(readSuggestions({ success: false })).toEqual([]);
    expect(readSuggestions("nonsense")).toEqual([]);
    expect(readResolvedAddress({ success: true, data: { address: null } })).toBeNull();
    expect(readResolvedAddress({ success: true, data: { address: { countryCode: "GB", line1: " 1 St ", locality: "" } } })).toEqual({ countryCode: "GB", line1: "1 St" });
  });
});

describe("address autocomplete", () => {
  it("waits 250 ms after the last key and 3 characters, then asks once with the words in the body", async () => {
    const { input, post } = start();
    type(input, "10");
    await settle();
    expect(post).not.toHaveBeenCalled();
    type(input, "10 D");
    await vi.advanceTimersByTimeAsync(200);
    type(input, "10 Dow");
    await vi.advanceTimersByTimeAsync(200);
    expect(post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0]!;
    expect(path).toBe("/address-rules/autocomplete/suggest");
    expect(body).toMatchObject({ provider: service.id, country: "GB", locale: "en", query: "10 Dow" });
    expect(body.sessionToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // The same token for the whole form.
    type(input, "10 Down");
    await settle();
    expect(post.mock.calls[1]![1].sessionToken).toBe(body.sessionToken);
  });

  it("shows the suggestions as a combobox listbox", async () => {
    const { input } = start();
    type(input, "10 Down");
    await settle();
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(listbox().id);
    expect(listbox().getAttribute("aria-labelledby")).toBe(document.querySelector("label")!.id);
    expect(options().map((option) => option.textContent)).toEqual(["10 Downing StreetLondon SW1A 2AA", "10 Downing PlaceCambridge CB2 3NY"]);
    expect(document.querySelector("[role=status]")!.textContent).toContain("2 address suggestions");
  });

  it("moves with the arrow keys, returns to the field past either end, and Escape closes", async () => {
    const { input } = start();
    type(input, "10 Down");
    await settle();
    expect(key(input, "ArrowDown").defaultPrevented).toBe(true);
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
    key(input, "ArrowDown");
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    key(input, "ArrowDown");
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    key(input, "ArrowUp");
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    const escape = key(input, "Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(listbox().hidden).toBe(true);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(options()).toHaveLength(0);
  });

  it("leaves Enter and the arrow keys to the field while no list is open", () => {
    const { input } = start();
    type(input, "10");
    expect(key(input, "ArrowDown").defaultPrevented).toBe(false);
    expect(key(input, "Enter").defaultPrevented).toBe(false);
  });

  it("Enter on the active suggestion fills the free-text fields and fires input and change", async () => {
    const { input, post, form } = start();
    const events: string[] = [];
    form.addEventListener("input", (event) => events.push(`input:${(event.target as HTMLInputElement).name}`));
    form.addEventListener("change", (event) => events.push(`change:${(event.target as HTMLInputElement).name}`));
    type(input, "10 Down");
    await settle();
    events.length = 0;
    key(input, "ArrowDown");
    expect(key(input, "Enter").defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    const [path, body] = post.mock.calls.at(-1)!;
    expect(path).toBe("/address-rules/autocomplete/resolve");
    expect(body).toMatchObject({ provider: service.id, country: "GB", locale: "en", id: "s1" });
    expect(input.value).toBe("10 Downing Street");
    expect(field("shippingDependentLocality").value).toBe("Westminster");
    expect(field("shippingLocality").value).toBe("London");
    expect(field("shippingAdminArea").value).toBe("England");
    expect(field("shippingPostalCode").value).toBe("SW1A 2AA");
    expect(field("shippingAddressLine2").value).toBe("");
    expect(events).toContain("input:shippingAddress");
    expect(events).toContain("change:shippingPostalCode");
    expect(listbox().hidden).toBe(true);
    // Filling the street line does not ask for suggestions again.
    await settle();
    expect(post.mock.calls.filter(([each]) => String(each).endsWith("/suggest"))).toHaveLength(1);
  });

  it("a click or tap chooses too, and keeps the focus in the field", async () => {
    const { input } = start();
    type(input, "10 Down");
    await settle();
    const down = new Event("pointerdown", { bubbles: true, cancelable: true });
    options()[1]!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    (options()[1]!.firstElementChild as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(input.value).toBe("10 Downing Street");
  });

  it("fills only the fields the form shows, and clears what the last choice put in a field the next one lacks", async () => {
    const post = vi.fn(async (path: string, body: Record<string, string>) => {
      if (path.endsWith("/suggest")) return SUGGESTIONS;
      return body.id === "s1" ? ADDRESS : { success: true, data: { address: { countryCode: "GB", line1: "1 High Street", locality: "Cambridge" } } };
    });
    const { input } = start({ post });
    document.getElementById("admin-wrapper")!.hidden = true;
    type(input, "10 Down");
    await settle();
    key(input, "ArrowDown");
    key(input, "Enter");
    await vi.advanceTimersByTimeAsync(0);
    expect(field("shippingAdminArea").value).toBe("");
    expect(field("shippingPostalCode").value).toBe("SW1A 2AA");
    // The buyer fixes the suburb; the second choice has no suburb or postal code.
    field("shippingDependentLocality").value = "Pimlico";
    input.focus();
    type(input, "1 High");
    await settle();
    key(input, "ArrowDown");
    key(input, "ArrowDown");
    key(input, "Enter");
    await vi.advanceTimersByTimeAsync(0);
    expect(input.value).toBe("1 High Street");
    expect(field("shippingLocality").value).toBe("Cambridge");
    expect(field("shippingPostalCode").value).toBe("");
    expect(field("shippingDependentLocality").value).toBe("Pimlico");
  });

  it("never fills when the country changed while the address loaded", async () => {
    let release: (value: unknown) => void = () => undefined;
    const post = vi.fn((path: string) => (path.endsWith("/suggest") ? Promise.resolve(SUGGESTIONS) : new Promise((resolve) => { release = resolve; })));
    const { input, select } = start({ post: post as never });
    type(input, "10 Down");
    await settle();
    key(input, "ArrowDown");
    key(input, "Enter");
    await vi.advanceTimersByTimeAsync(0);
    select.value = "US";
    release(ADDRESS);
    await vi.advanceTimersByTimeAsync(0);
    expect(input.value).toBe("10 Down");
    expect(field("shippingLocality").value).toBe("");
  });

  it("does nothing for a country the app does not serve or for Bangladesh", async () => {
    for (const country of ["US", "BD"]) {
      const { input, post } = start({}, country);
      type(input, "10 Downing");
      await settle();
      expect(post).not.toHaveBeenCalled();
      expect(input.hasAttribute("aria-activedescendant")).toBe(false);
      document.body.innerHTML = "";
    }
  });

  it("drops the list when the country changes", async () => {
    const { input, select } = start();
    type(input, "10 Down");
    await settle();
    expect(options()).toHaveLength(2);
    select.value = "US";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(listbox().hidden).toBe(true);
  });

  it("answers failures, empty lists and bad answers with silence: the buyer types as usual", async () => {
    for (const answer of [
      () => Promise.reject(new Error("offline")),
      () => Promise.resolve({ success: true, data: { suggestions: [] } }),
      () => Promise.resolve({ success: false }),
      () => Promise.resolve("<html>"),
    ]) {
      const { input } = start({ post: vi.fn(answer) as never });
      type(input, "10 Down");
      await settle();
      expect(listbox().hidden).toBe(true);
      expect(input.value).toBe("10 Down");
      document.body.innerHTML = "";
    }
  });

  it("a failing resolve leaves what was typed", async () => {
    const post = vi.fn((path: string) => (path.endsWith("/suggest") ? Promise.resolve(SUGGESTIONS) : Promise.reject(new Error("offline"))));
    const { input } = start({ post: post as never });
    type(input, "10 Down");
    await settle();
    key(input, "ArrowDown");
    key(input, "Enter");
    await vi.advanceTimersByTimeAsync(0);
    expect(input.value).toBe("10 Down");
    expect(field("shippingPostalCode").value).toBe("");
  });

  it("ignores a slow answer for words the buyer has since changed", async () => {
    let release: (value: unknown) => void = () => undefined;
    const post = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const { input } = start({ post: post as never });
    type(input, "10 Down");
    await settle();
    type(input, "20");
    release(SUGGESTIONS);
    await vi.advanceTimersByTimeAsync(0);
    expect(listbox().hidden).toBe(true);
  });

  it("puts nothing about the buyer in a URL and leaves the field when it is torn down", async () => {
    const controller = new AbortController();
    const { input, post } = start({ signal: controller.signal });
    type(input, "10 Down");
    await settle();
    expect(JSON.stringify(post.mock.calls[0]![0])).not.toContain("10");
    controller.abort();
    expect(input.hasAttribute("role")).toBe(false);
    expect(document.querySelector("[role=listbox]")).toBeNull();
  });

  it("speaks Bangla when the page does", async () => {
    const { input } = start({ locale: "bn" });
    type(input, "10 Down");
    await settle();
    expect(document.querySelector("[role=status]")!.textContent).toContain("ঠিকানার পরামর্শ");
  });
});
