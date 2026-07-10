import { dispatch, type DispatchReceipt } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import {
  admitScaliusComputerResult,
  type ScaliusComputerResultContinuation,
} from "@scalius/shared/assistant-computer-handoff";
import { Hono } from "hono";
import adminCopilot from "./agents/admin-copilot";
import {
  authorizeAgentRequest,
  authorizeThreadInstanceRequest,
  type CanaryAuthEnv,
} from "./auth";

const SERVICE_NAME = "scalius-admin-agent-flue-canary";
const AGENT_NAME = "admin-copilot";

export interface AdminCanaryAppDependencies {
  dispatchComputerResult?: (
    instanceId: string,
    continuation: ScaliusComputerResultContinuation,
  ) => Promise<DispatchReceipt>;
}

export function createAdminCanaryApp(dependencies: AdminCanaryAppDependencies = {}) {
  const app = new Hono<{ Bindings: CanaryAuthEnv }>();
  const dispatchComputerResult = dependencies.dispatchComputerResult ??
    ((instanceId, continuation) => dispatch(adminCopilot, { id: instanceId, input: continuation }));

  app.get("/health", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, service: SERVICE_NAME, runtime: "flue-cloudflare", version: "0.1.0" });
  });

  app.post("/computer/results/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    const instanceId = c.req.param("id");
    const authorization = await authorizeThreadInstanceRequest(c.req.raw, c.env, "admin", instanceId);
    const signingKey = c.env.COMPUTER_TICKET_SIGNING_KEY;
    if (!authorization.authorized || !signingKey || signingKey.length < 32) {
      return c.json({ error: "Not found" }, 404);
    }
    const admission = await admitScaliusComputerResult({
      request: c.req.raw,
      surface: "admin",
      agentName: AGENT_NAME,
      instanceId,
      signingKey,
    });
    if (!admission.ok) {
      const status = admission.code === "OVERSIZE" ? 413 : 400;
      return c.json({ error: "Computer result was rejected", code: admission.code }, status);
    }
    try {
      const receipt = await dispatchComputerResult(instanceId, admission.continuation);
      return c.json({
        accepted: true,
        authoritative: false,
        status: "queued_for_agent_interpretation",
        requestId: admission.continuation.requestId,
        dispatchId: receipt.dispatchId,
      }, 202);
    } catch {
      return c.json({ error: "Computer result could not be queued" }, 503);
    }
  });

  app.use("/agents/*", async (c, next) => {
    const result = await authorizeAgentRequest(c.req.raw, c.env, AGENT_NAME, "admin");
    if (!result.authorized) {
      c.header("Cache-Control", "no-store");
      return c.json({ error: "Not found" }, 404);
    }
    await next();
  });

  app.route("/", flue());
  return app;
}

export default createAdminCanaryApp();
