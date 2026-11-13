import type { APIRoute } from "astro";
import { getLayoutData } from "@/lib/api/storefront";
import { getUcpBaseUrl } from "@/lib/ucp/catalog";
import {
  llmsTxtNotConfiguredResponse,
  llmsTxtResponse,
  llmsTxtStoreOf,
  llmsTxtUnavailableResponse,
} from "@/lib/llms-txt";
import { httpsRedirectResponse } from "@/lib/storefront-origin";

export const prerender = false;

// The store's own facts come from the layout read the middleware already
// made for this route: no read of its own.
export const GET: APIRoute = async ({ request }) => {
  // A plain-http request for a named host goes to https, as the gateway sends every page;
  // what is left of http is the store's own setting (or a loopback stack).
  const toHttps = httpsRedirectResponse(request);
  if (toHttps) return toHttps;
  // No https web address (a loopback one serves local development) is the
  // merchant's setting, not a passing failure: say so, never "temporarily".
  let baseUrl: string;
  try {
    baseUrl = getUcpBaseUrl();
  } catch {
    return llmsTxtNotConfiguredResponse();
  }
  try {
    return llmsTxtResponse(baseUrl, llmsTxtStoreOf(await getLayoutData(), baseUrl));
  } catch {
    return llmsTxtUnavailableResponse();
  }
};
