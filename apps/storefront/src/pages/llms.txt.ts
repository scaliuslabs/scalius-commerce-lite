import type { APIRoute } from "astro";
import { getLayoutData } from "@/lib/api/storefront";
import { getUcpBaseUrl } from "@/lib/ucp/catalog";
import {
  llmsTxtNotConfiguredResponse,
  llmsTxtResponse,
  llmsTxtStoreOf,
  llmsTxtUnavailableResponse,
} from "@/lib/llms-txt";

export const prerender = false;

// The store's own facts come from the layout read the middleware already
// made for this route: no read of its own.
export const GET: APIRoute = async () => {
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
