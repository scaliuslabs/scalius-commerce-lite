import type { APIRoute } from "astro";
import {
  buildUcpProfile,
  getUcpBaseUrl,
  ucpJsonResponse,
  ucpOptionsResponse,
  ucpProfileNotConfiguredResponse,
  ucpProfileUnavailableResponse,
} from "@/lib/ucp/catalog";
import { httpsRedirectResponse } from "@/lib/storefront-origin";

export const prerender = false;

export const OPTIONS: APIRoute = async () => ucpOptionsResponse();

export const GET: APIRoute = async ({ request }) => {
  // A plain-http request for a named host goes to https, as the gateway sends every page.
  const toHttps = httpsRedirectResponse(request);
  if (toHttps) return toHttps;
  // A store without an https web address has no UCP profile until the
  // merchant sets one: say so (404, no retry), never "temporarily".
  let baseUrl: string;
  try {
    baseUrl = getUcpBaseUrl();
  } catch {
    return ucpProfileNotConfiguredResponse();
  }
  try {
    return ucpJsonResponse(buildUcpProfile(baseUrl));
  } catch {
    return ucpProfileUnavailableResponse();
  }
};
