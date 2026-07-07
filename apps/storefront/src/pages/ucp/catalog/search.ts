import type { APIRoute } from "astro";
import {
  getUcpCatalogContext,
  parseJsonBody,
  searchCatalog,
  ucpErrorResponse,
  ucpJsonResponse,
  ucpOptionsResponse,
  ucpUnavailableResponse,
  validateUcpRequest,
} from "@/lib/ucp/catalog";

export const prerender = false;

export const OPTIONS: APIRoute = async () => ucpOptionsResponse();

export const POST: APIRoute = async ({ request }) => {
  const body = await parseJsonBody(request);
  if (!body) {
    return ucpErrorResponse(400, "request_invalid", "Request body must be a JSON object.");
  }

  const validationErrors = validateUcpRequest(request, body);
  if (validationErrors.length > 0) {
    const first = validationErrors[0]!;
    return ucpErrorResponse(422, first.code, first.content, first.path);
  }

  const context = await getUcpCatalogContext();
  if (!context) {
    return ucpUnavailableResponse("Catalog context is temporarily unavailable.");
  }

  const result = await searchCatalog(body, context);
  return ucpJsonResponse(result.body, result.status, result.status >= 400
    ? { "Cache-Control": "private, no-cache, no-store, must-revalidate" }
    : {});
};
