// The one answer for an API path nothing serves, from every layer that can
// decide it: the Worker's family and group dispatch (before any route graph
// loads), every route group's app (base-app.ts) and the dashboard surface's
// API paths. Kept free of imports so the dispatch loads nothing to say it.

export const API_NOT_FOUND_MESSAGE = "No API endpoint has this path";

/** 404 `not_found` in the standard error shape, never cached. */
export function apiNotFoundResponse(): Response {
  return Response.json(
    { success: false, error: { code: "not_found", message: API_NOT_FOUND_MESSAGE } },
    { status: 404, headers: { "Cache-Control": "private, no-store" } },
  );
}
