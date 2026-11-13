import type { APIRoute } from "astro";
import { getLayoutData } from "@/lib/api/storefront";
import { getUcpBaseUrl } from "@/lib/ucp/catalog";
import {
  llmsTxtResponse,
  llmsTxtStoreOf,
  llmsTxtUnavailableResponse,
} from "@/lib/llms-txt";

export const prerender = false;

// The store's own facts come from the layout read the middleware already
// made for this route: no read of its own.
export const GET: APIRoute = async () => {
  try {
    const baseUrl = getUcpBaseUrl();
    return llmsTxtResponse(baseUrl, llmsTxtStoreOf(await getLayoutData(), baseUrl));
  } catch {
    return llmsTxtUnavailableResponse();
  }
};
