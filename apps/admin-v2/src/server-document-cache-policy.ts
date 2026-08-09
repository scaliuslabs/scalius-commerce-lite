const HTML_CONTENT_TYPE = "text/html";

function requestsDocument(request: Request): boolean {
  return request.headers.get("Accept")?.toLowerCase().includes(HTML_CONTENT_TYPE) ?? false;
}

function respondsWithHtml(response: Response): boolean {
  return response.headers.get("Content-Type")?.toLowerCase().includes(HTML_CONTENT_TYPE) ?? false;
}

/**
 * Dashboard documents must pick up the current hashed asset manifest after a
 * deploy. Hashed assets and JSON/RPC responses keep their own cache policy.
 * Do not add `no-transform`: Cloudflare then stops compressing the document.
 */
export function applyAdminDocumentCachePolicy(
  request: Request,
  response: Response,
): Response {
  if (!requestsDocument(request) && !respondsWithHtml(response)) return response;

  const securedResponse = new Response(response.body, response);
  securedResponse.headers.set(
    "Cache-Control",
    "private, no-store, max-age=0, must-revalidate",
  );
  securedResponse.headers.set("Pragma", "no-cache");
  securedResponse.headers.set("Expires", "0");
  return securedResponse;
}
