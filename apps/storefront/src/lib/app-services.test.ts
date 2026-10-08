// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import {
  addressAutocompleteService,
  appServiceGlobals,
  pageLocale,
  searchProvider,
  serviceCoversCountry,
} from "./app-services";

afterEach(() => {
  delete window.__SEARCH_PROVIDER__;
  delete window.__ADDRESS_AUTOCOMPLETE__;
  document.documentElement.lang = "";
});

describe("app services on the page", () => {
  it("writes no global for a store without apps", () => {
    expect(appServiceGlobals(undefined)).toEqual([]);
    expect(appServiceGlobals({ search: null, address: null })).toEqual([]);
  });

  it("writes the search app and the address app as inline-safe globals", () => {
    const statements = appServiceGlobals({ search: "acme.search/semantic", address: { id: "acme.addresses/lookup", countries: ["GB", "AE"] } });
    expect(statements).toEqual([
      'window.__SEARCH_PROVIDER__="acme.search/semantic";',
      'window.__ADDRESS_AUTOCOMPLETE__={"id":"acme.addresses/lookup","countries":["GB","AE"]};',
    ]);
    expect(appServiceGlobals({ search: "</script><script>x" })[0]).not.toContain("<");
  });

  it("reads them back, and rejects a malformed one", () => {
    expect(searchProvider()).toBeNull();
    expect(addressAutocompleteService()).toBeNull();
    window.__SEARCH_PROVIDER__ = "acme.search/semantic";
    window.__ADDRESS_AUTOCOMPLETE__ = { id: "acme.addresses/lookup", countries: "any" };
    expect(searchProvider()).toBe("acme.search/semantic");
    expect(addressAutocompleteService()).toEqual({ id: "acme.addresses/lookup", countries: "any" });
    window.__ADDRESS_AUTOCOMPLETE__ = { id: "x", countries: "GB" as never };
    expect(addressAutocompleteService()).toBeNull();
  });

  it("matches a country in any case, only two letters", () => {
    const list = { id: "a/b", countries: ["GB", "ae"] };
    expect(serviceCoversCountry(list, "gb")).toBe(true);
    expect(serviceCoversCountry(list, "AE")).toBe(true);
    expect(serviceCoversCountry(list, "US")).toBe(false);
    expect(serviceCoversCountry({ id: "a/b", countries: "any" }, "US")).toBe(true);
    expect(serviceCoversCountry({ id: "a/b", countries: "any" }, "USA")).toBe(false);
  });

  it("gives the page language as two lowercase letters", () => {
    expect(pageLocale()).toBe("en");
    document.documentElement.lang = "bn-BD";
    expect(pageLocale()).toBe("bn");
  });
});
