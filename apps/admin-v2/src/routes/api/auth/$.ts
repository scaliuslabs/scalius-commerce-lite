/**
 * Better Auth catch-all server route.
 *
 * Handles all /api/auth/* requests (GET and POST) by forwarding them
 * to the Better Auth handler running on admin-v2's own D1.
 * Since admin-v2 shares D1 with the API worker (via symlink in dev),
 * sessions created here are also valid for API requests.
 */

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { createAuthHandler } = await import("~/lib/auth.server");
        const handler = createAuthHandler();
        return handler(request);
      },
      POST: async ({ request }) => {
        const { createAuthHandler } = await import("~/lib/auth.server");
        const handler = createAuthHandler();
        return handler(request);
      },
    },
  },
});
