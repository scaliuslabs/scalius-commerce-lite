import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";
import { authorizeAgentRequest, type CanaryAuthEnv } from "./auth";

const SERVICE_NAME = "scalius-admin-agent-flue-canary";
const app = new Hono<{ Bindings: CanaryAuthEnv }>();

app.get("/health", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true, service: SERVICE_NAME, runtime: "flue-cloudflare", version: "0.1.0" });
});

app.use("/agents/*", async (c, next) => {
  const result = await authorizeAgentRequest(c.req.raw, c.env, "admin-copilot", "admin");
  if (!result.authorized) {
    c.header("Cache-Control", "no-store");
    return c.json({ error: "Not found" }, 404);
  }
  await next();
});

app.route("/", flue());

export default app;
