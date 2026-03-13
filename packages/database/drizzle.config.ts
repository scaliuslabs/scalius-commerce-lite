import type { Config } from "drizzle-kit";

// For D1: drizzle-kit only needs schema + output dir for "generate".
// Migrations are applied via: wrangler d1 migrations apply DB --local/--remote
export default {
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "sqlite",
} satisfies Config;
