import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: async () => {
        return new Response(
          JSON.stringify({
            status: "ok",
            timestamp: Date.now(),
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store, max-age=0",
            },
          },
        );
      },
    },
  },
});
