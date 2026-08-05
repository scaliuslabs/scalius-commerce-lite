import handler from "@tanstack/react-start/server-entry";
import {
  applyBaselineSecurityHeaders,
  redirectPlaintextRequest,
} from "@scalius/shared/http-security";
import { createDatabaseMigrationFreezeResponse } from "@scalius/shared/database-migration-freeze";
import { withPublicMediaUrl } from "@scalius/core/integrations/storage";
import { applyAdminDocumentCachePolicy } from "./server-document-cache-policy";

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

    const response = await withPublicMediaUrl(
      env.R2_PUBLIC_URL ?? "",
      () => handler.fetch(request),
    );
    return applyBaselineSecurityHeaders(
      request,
      applyAdminDocumentCachePolicy(request, response),
      { frameProtection: "deny" },
    );
  },
};
