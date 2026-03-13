export const prerender = false;

/**
 * Health check endpoint for the application
 * This endpoint is used by monitoring systems to check if the application is running
 */
export async function GET() {
  try {
    // Get environment information
    const environment = process.env.NODE_ENV || "development";
    const version = process.env.npm_package_version || "1.0.0";

    // Get memory usage
    const memoryUsage = process.memoryUsage();

    // Calculate uptime
    const uptime = process.uptime();
    const uptimeFormatted = formatUptime(uptime);

    // Return health check response
    return new Response(
      JSON.stringify({
        status: "ok",
        timestamp: new Date().toISOString(),
        environment,
        version,
        uptime: uptimeFormatted,
        memory: {
          rss: formatBytes(memoryUsage.rss),
          heapTotal: formatBytes(memoryUsage.heapTotal),
          heapUsed: formatBytes(memoryUsage.heapUsed),
          external: formatBytes(memoryUsage.external),
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  } catch (error) {
    console.error("Health check failed:", error);

    return new Response(
      JSON.stringify({
        status: "error",
        timestamp: new Date().toISOString(),
        message: "Health check failed",
        error: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  }
}

/**
 * Format bytes to a human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Format uptime in a human-readable format
 */
function formatUptime(uptime: number): string {
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}
