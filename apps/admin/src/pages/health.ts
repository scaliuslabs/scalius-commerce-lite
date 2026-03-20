export const prerender = false;

/**
 * Health check endpoint for monitoring systems.
 * Cloudflare Workers don't expose process.memoryUsage() or process.uptime(),
 * so this returns a minimal response.
 */
export async function GET() {
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
}
