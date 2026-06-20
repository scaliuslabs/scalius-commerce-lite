/**
 * Better Auth catch-all server route.
 *
 * Handles all /api/auth/* requests (GET and POST) by forwarding them
 * to the Better Auth handler running on admin-v2's own D1.
 * Since admin-v2 shares D1 with the API worker (via symlink in dev),
 * sessions created here are also valid for API requests.
 */

import { createFileRoute } from "@tanstack/react-router";
import { shouldRejectCrossOriginCookieRequest } from "@scalius/shared/request-origin-guard";

function crossOriginCookieRequestResponse(): Response {
  return Response.json(
    { success: false, error: "Cross-origin cookie request denied" },
    { status: 403 },
  );
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { createAuthHandler } = await import("~/lib/auth.server");
        const handler = createAuthHandler();
        return handler(request);
      },
      POST: async ({ request }) => {
        if (shouldRejectCrossOriginCookieRequest(request)) {
          return crossOriginCookieRequestResponse();
        }
        const { createAuthHandler } = await import("~/lib/auth.server");
        const handler = createAuthHandler();
        return handler(request);
      },
    },
  },
});
