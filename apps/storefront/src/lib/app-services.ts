/**
 * Buyer services of active apps (layout `appServices`): the search app that
 * ranks predictive search and the address app that completes a street line.
 * The layout writes them as page globals only when an app provides one, and
 * browser code reads them here, so a store without apps ships and loads none
 * of it.
 */
import { readSignInApps, type SignInApp } from "./sign-in-apps";

export interface AddressAutocompleteService {
  id: string;
  /** `"any"` or the two-letter codes the app completes addresses for. */
  countries: "any" | string[];
}

export interface AppServices {
  search?: string | null;
  address?: AddressAutocompleteService | null;
  /** Sign-in apps ("Continue with <app>"). */
  signIn?: Array<{ id: string; name: string }>;
}

/** The layout's page globals for active apps' buyer services (components/WindowGlobals.astro writes them). */
export function appServiceGlobals(services: AppServices | null | undefined): Record<string, unknown> {
  const globals: Record<string, unknown> = {};
  const search = services?.search;
  if (typeof search === "string" && search) globals.__SEARCH_PROVIDER__ = search;
  const address = services?.address;
  if (address && typeof address.id === "string" && address.id) {
    globals.__ADDRESS_AUTOCOMPLETE__ = {
      id: address.id,
      countries: address.countries === "any" ? "any" : address.countries,
    };
  }
  const signIn = readSignInApps(services?.signIn);
  if (signIn.length > 0) globals.__SIGN_IN_APPS__ = signIn;
  return globals;
}

/** The sign-in apps the page's layout names (the sign-in dialog offers them). */
export function signInApps(): SignInApp[] {
  return typeof window === "undefined" ? [] : readSignInApps(window.__SIGN_IN_APPS__);
}

/** The search app id the page's layout names, or null. */
export function searchProvider(): string | null {
  if (typeof window === "undefined") return null;
  const id = window.__SEARCH_PROVIDER__;
  return typeof id === "string" && id ? id : null;
}

/** The address autocomplete service the page's layout names, or null. */
export function addressAutocompleteService(): AddressAutocompleteService | null {
  if (typeof window === "undefined") return null;
  const service = window.__ADDRESS_AUTOCOMPLETE__;
  if (!service || typeof service.id !== "string" || !service.id) return null;
  if (service.countries !== "any" && !Array.isArray(service.countries)) return null;
  return service;
}

/** Whether the service completes addresses for this country (two letters, any case). */
export function serviceCoversCountry(
  service: AddressAutocompleteService,
  country: string,
): boolean {
  const code = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return false;
  if (service.countries === "any") return true;
  return service.countries.some((entry) => entry.toUpperCase() === code);
}

/** The page language as two lowercase letters, for the search and address apps. */
export function pageLocale(): string {
  if (typeof document === "undefined") return "en";
  const match = /^[a-z]{2}/i.exec(document.documentElement.lang || "");
  return match ? match[0].toLowerCase() : "en";
}
