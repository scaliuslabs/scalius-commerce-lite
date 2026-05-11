import type { Config } from "drizzle-kit";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// For D1: drizzle-kit only needs schema + output dir for "generate".
// Migrations are applied via: wrangler d1 migrations apply DB --local/--remote
export default {
  schema: resolve(here, "src/schema/index.ts"),
  out: "./migrations",
  dialect: "sqlite",
} satisfies Config;
