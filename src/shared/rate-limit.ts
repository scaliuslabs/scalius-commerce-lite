// Use standard Request type from Fetch API instead of Cloudflare
// No need for explicit import as Request is a global type in modern browsers and Node.js

interface RateLimitOptions {
  windowMs: number; // milliseconds
  max: number; // max requests per windowMs
  message?: string; // error message
  statusCode?: number; // error status code
  requestPropertyName?: string; // property on req object to use as key
}

interface RateLimitResponse {
  check: (req: Request) => Promise<void>;
}

// Simple in-memory store for rate limiting
const ipHitMap = new Map<string, { hits: number; resetTime: number }>();

// Clean up expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of ipHitMap.entries()) {
    if (value.resetTime <= now) {
      ipHitMap.delete(key);
    }
  }
}, 60000); // Clean up every minute

export function rateLimit(options: RateLimitOptions): RateLimitResponse {
  const windowMs = options.windowMs || 60 * 1000; // default: 1 minute
  const max = options.max || 100; // default: 100 requests per minute
  const message =
    options.message || "Too many requests, please try again later.";

  return {
    check: async (req: Request) => {
      // Get IP from headers or fall back to a default
      const ip =
        req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
        req.headers.get("x-real-ip") ||
        "unknown";

      const now = Date.now();

      // Initialize or get existing record
      let record = ipHitMap.get(ip);
      if (!record) {
        record = {
          hits: 0,
          resetTime: now + windowMs,
        };
        ipHitMap.set(ip, record);
      } else if (record.resetTime <= now) {
        // Reset if the window has passed
        record.hits = 0;
        record.resetTime = now + windowMs;
      }

      // Increment hit counter
      record.hits++;

      // Check if over limit
      if (record.hits > max) {
        throw new Error(message);
      }
    },
  };
}
