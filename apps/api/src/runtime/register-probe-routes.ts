import type { RuntimeApiApp } from "./base-app";
import { metaRoutes } from "../routes/meta";
import { readinessRoutes } from "../routes/readiness";

export function registerProbeRoutes(app: RuntimeApiApp): void {
  app.get("/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));
  app.route("/", readinessRoutes);
  app.route("/meta", metaRoutes);
}
