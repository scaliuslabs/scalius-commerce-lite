import { dispatch, type DispatchReceipt } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import {
  admitScaliusComputerResult,
  type ScaliusComputerResultContinuation,
} from "@scalius/shared/assistant-computer-handoff";
import { Hono } from "hono";
import shoppingAssistant from "./agents/shopping-assistant";
import type { StorefrontScaliusEnv } from "./scalius";
import {
  authorizeAgentRequest,
  authorizeThreadInstanceRequest,
  isStorefrontAgentAuthConfigured,
  type AuthorizationResult,
  type CanaryAuthEnv,
} from "./auth";

const SERVICE_NAME = "scalius-storefront-agent-flue-canary";
const AGENT_NAME = "shopping-assistant";

export interface StorefrontCanaryAppDependencies {
  dispatchComputerResult?: (
    instanceId: string,
    continuation: ScaliusComputerResultContinuation,
  ) => Promise<DispatchReceipt>;
  recordAuthorizationFailure?: (
    endpoint: "agent" | "computer_result",
    reason: Extract<AuthorizationResult, { authorized: false }>["reason"],
  ) => void;
}

function defaultRecordAuthorizationFailure(
  endpoint: "agent" | "computer_result",
  reason: Extract<AuthorizationResult, { authorized: false }>["reason"],
): void {
  if (
    reason !== "service_token_invalid" &&
    reason !== "thread_identity_invalid"
  ) {
    return;
  }
  console.error(
    JSON.stringify({
      event: "storefront_flue_authorization_rejected",
      endpoint,
      reason,
    }),
  );
}

export function createStorefrontCanaryApp(dependencies: StorefrontCanaryAppDependencies = {}) {
  const app = new Hono<{ Bindings: CanaryAuthEnv & StorefrontScaliusEnv }>();
  const dispatchComputerResult = dependencies.dispatchComputerResult ??
    ((instanceId, continuation) => dispatch(shoppingAssistant, { id: instanceId, input: continuation }));
  const recordAuthorizationFailure =
    dependencies.recordAuthorizationFailure ?? defaultRecordAuthorizationFailure;

  app.get("/health", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ ok: true, service: SERVICE_NAME, runtime: "flue-cloudflare", version: "0.1.0" });
  });

  app.get("/readyz", (c) => {
    c.header("Cache-Control", "no-store");
    const locallyConfigured =
      isStorefrontAgentAuthConfigured(c.env) &&
      typeof c.env.API?.fetch === "function";
    const body = {
      locallyConfigured,
      endToEnd: false,
      service: SERVICE_NAME,
      runtime: "flue-cloudflare",
      readiness: locallyConfigured
        ? "local_configuration_present"
        : "configuration_unavailable",
    } as const;
    return locallyConfigured ? c.json(body, 200) : c.json(body, 503);
  });

  app.get("/readyz/agents/:name/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    if (c.req.param("name") !== AGENT_NAME) {
      return c.body(null, 404);
    }
    const authorization = await authorizeThreadInstanceRequest(
      c.req.raw,
      c.env,
      "storefront",
      c.req.param("id"),
    );
    if (!authorization.authorized) {
      recordAuthorizationFailure("agent", authorization.reason);
      return c.body(null, 404);
    }
    if (typeof c.env.API?.fetch !== "function") {
      return c.body(null, 503);
    }
    c.header("X-Scalius-Readiness", "facade-authenticated");
    return c.body(null, 204);
  });

  app.post("/computer/results/:id", async (c) => {
    c.header("Cache-Control", "no-store");
    const instanceId = c.req.param("id");
    const authorization = await authorizeThreadInstanceRequest(c.req.raw, c.env, "storefront", instanceId);
    const signingKey = c.env.COMPUTER_TICKET_SIGNING_KEY;
    if (!authorization.authorized) {
      recordAuthorizationFailure("computer_result", authorization.reason);
      return c.json({ error: "Not found" }, 404);
    }
    if (!signingKey || signingKey.length < 32) {
      return c.json({ error: "Not found" }, 404);
    }
    const admission = await admitScaliusComputerResult({
      request: c.req.raw,
      surface: "storefront",
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
    const result = await authorizeAgentRequest(c.req.raw, c.env, AGENT_NAME, "storefront");
    if (!result.authorized) {
      recordAuthorizationFailure("agent", result.reason);
      c.header("Cache-Control", "no-store");
      return c.json({ error: "Not found" }, 404);
    }
    await next();
  });

  app.route("/", flue());
  return app;
}

export default createStorefrontCanaryApp();
