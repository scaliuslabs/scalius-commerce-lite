import handler from "@tanstack/react-start/server-entry";
import {
  applyBaselineSecurityHeaders,
  redirectPlaintextRequest,
} from "@scalius/shared/http-security";
import { createDatabaseMigrationFreezeResponse } from "@scalius/shared/database-migration-freeze";
import { describeMissingMasterSecret } from "@scalius/shared/runtime-secrets";
import { withPublicMediaUrl } from "@scalius/core/integrations/storage";
import { applyAdminDocumentCachePolicy } from "./server-document-cache-policy";
import {
  composeAdminRuntimeEnv,
  hasMasterSecret,
  runWithRuntimeEnv,
} from "./lib/runtime-env.server";

const HEALTH_PATHS = new Set(["/health", "/health/"]);

function isHealthPath(pathname: string): boolean {
  return HEALTH_PATHS.has(pathname);
}

/**
 * Without the master secret no admin session can be verified. Fail closed
 * for everything except the health probe, which keeps reporting liveness.
 */
function missingMasterSecretResponse(): Response {
  return Response.json(
    {
      success: false,
      error: describeMissingMasterSecret(),
      code: "RUNTIME_SECRET_MISSING",
    },
    { status: 503, headers: { "Cache-Control": "private, no-store" } },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const redirect = redirectPlaintextRequest(request);
    if (redirect) return redirect;

    const migrationResponse = createDatabaseMigrationFreezeResponse(
      request,
      env,
    );
    if (migrationResponse) {
      return applyBaselineSecurityHeaders(request, migrationResponse, {
        frameProtection: "deny",
      });
    }

    if (!hasMasterSecret(env) && !isHealthPath(new URL(request.url).pathname)) {
      return applyBaselineSecurityHeaders(request, missingMasterSecretResponse(), {
        frameProtection: "deny",
      });
    }

    const runtime = await composeAdminRuntimeEnv(env, request);
    const response = await runWithRuntimeEnv(runtime.env, () =>
      withPublicMediaUrl(
        runtime.env.R2_PUBLIC_URL ?? "",
        () => handler.fetch(request),
      ),
    );
    return applyBaselineSecurityHeaders(
      request,
      applyAdminDocumentCachePolicy(request, response),
      { frameProtection: "deny" },
    );
  },
};
