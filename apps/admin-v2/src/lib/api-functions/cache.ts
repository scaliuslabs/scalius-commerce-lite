import { createServerFn } from "@tanstack/react-start";
import { apiBasePost } from "../api.server";

/** Store-wide refresh lives outside /api/v1/admin, so it stays a server function. */
export const clearCache = createServerFn({ method: "POST" }).handler(
  async () => apiBasePost<{ message?: string }>("/cache/clear"),
);
