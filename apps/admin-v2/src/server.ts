import handler from "@tanstack/react-start/server-entry";
import {
  applyBaselineSecurityHeaders,
  redirectPlaintextRequest,
} from "@scalius/shared/http-security";
import { applyAdminDocumentCachePolicy } from "./server-document-cache-policy";

export default {
  async fetch(request: Request): Promise<Response> {
    const redirect = redirectPlaintextRequest(request);
    if (redirect) return redirect;

    const response = await handler.fetch(request);
    return applyBaselineSecurityHeaders(
      request,
      applyAdminDocumentCachePolicy(request, response),
      { frameProtection: "deny" },
    );
  },
};
