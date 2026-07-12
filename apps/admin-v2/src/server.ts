import handler from "@tanstack/react-start/server-entry";
import { applyAdminDocumentCachePolicy } from "./server-document-cache-policy";

export default {
  async fetch(request: Request): Promise<Response> {
    const response = await handler.fetch(request);
    return applyAdminDocumentCachePolicy(request, response);
  },
};
