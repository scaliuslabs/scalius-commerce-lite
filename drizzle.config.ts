// drizzle.config.ts
import type { Config } from "drizzle-kit";
import { loadEnv } from "vite";

// Load environment variables
const env = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");

export default {
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "turso",
  dbCredentials: {
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  },
} satisfies Config;
