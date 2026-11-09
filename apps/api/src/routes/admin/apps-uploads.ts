// App uploads (COMMERCE-HOOKS H17): a file staff choose in an app's admin
// form (a `file-field`, e.g. a CSV import). The dashboard sends it here
// first, then posts the form with the upload id as the field's value; the
// app hands the id to a background job and reads the file in slices
// (`ctx.uploads`).
//
//   POST /api/v1/admin/apps/{id}/uploads    multipart: file, route
//
// The staff member needs what the form's own route needs: apps.use (route
// permissions), and, for a scope-gated route, the scope granted to the app
// and its staff permission. The route must be one the app declares for a
// write. The file is read whole, bounded by the plan's upload size, typed
// from its bytes (UTF-8 text without control characters or markup: CSV) and
// stored privately in the buyer-uploads store, bound to the app and route.
// Logs carry ids only: never a file name or its bytes. Registered by apps.ts.
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { appUploadStaffKey, stageAppUpload } from "@scalius/core/modules/buyer-uploads";
import { AppError } from "@scalius/core/errors";
import { getActivePluginInstallation } from "@scalius/core/modules/plugins";
import { ADMIN_UPLOAD_TYPES, BUYER_UPLOAD_ID_PATTERN } from "@scalius/shared/buyer-uploads";
import { PLUGIN_ID_PATTERN, PLUGIN_SCOPES, PLUGIN_URL_NAME_PATTERN } from "@scalius/shared/plugins";
import { planLimits } from "@scalius/shared/plan-limits";
import { created } from "../../utils/api-response";
import { ForbiddenError, NotFoundError, RateLimitError, ValidationError } from "../../utils/api-error";
import { isWithinRateLimit } from "../../utils/rate-limit";
import { errorResponses, serviceUnavailableResponse, successEnvelope } from "../../schemas/responses";
import { requireStaffId } from "./request-actor";

/** Multipart framing on top of the file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH"]);

export const appUploadSchema = z.object({
  id: z.string().regex(BUYER_UPLOAD_ID_PATTERN).openapi({ description: "The upload id (`bup_` and 24 characters): send it as the form field's value." }),
  filename: z.string(),
  mediaType: z.enum(ADMIN_UPLOAD_TYPES).openapi({ description: "Typed from the bytes: `text/csv` is UTF-8 text without control characters or markup." }),
  sizeBytes: z.number().int(),
  expiresAt: z.string().openapi({ description: "When the platform deletes the file unless the app deleted it before (ISO 8601)." }),
}).openapi("AppUpload");

const uploadRoute = createRoute({
  method: "post",
  path: "/{id}/uploads",
  operationId: "dashboard.apps.uploads_create",
  tags: ["Admin - Apps"],
  summary: "Upload a file for one of an app's admin forms",
  description: "Multipart form: `file` and `route`, the admin route the form posts to (one the app declares for POST, PUT or PATCH). Needs apps.use and, for a scope-gated route, the route's scope. The type is read from the bytes (CSV: UTF-8 text); the file stays private to the app, which reads it with ctx.uploads. Files the app does not delete are deleted after 72 hours.",
  request: {
    params: z.object({ id: z.string().regex(PLUGIN_ID_PATTERN).openapi({ description: "The app's id (vendor.name)." }) }),
    body: {
      required: true,
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: z.any().openapi({ type: "string", format: "binary" }),
            route: z.string().max(64),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "The stored upload", content: { "application/json": { schema: successEnvelope(z.object({ upload: appUploadSchema })) } } },
    ...errorResponses,
    503: serviceUnavailableResponse,
  },
});

export function registerAppUploadRoutes(app: OpenAPIHono<{ Bindings: Env }>): void {
  app.openapi(uploadRoute, async (c) => {
    c.header("Cache-Control", "private, no-store");
    const pluginId = c.req.valid("param").id;
    // A person in the dashboard: agents and apps never upload for an app's form.
    if (c.get("agentPrincipal") || c.get("pluginPrincipal")) throw new ForbiddenError("Only staff in the dashboard upload files for an app.");
    const staffId = requireStaffId(c, "Sign in again to upload a file.");
    if (!(await isWithinRateLimit(c.env, "RL_STANDARD", "app-upload", staffId))) {
      throw new RateLimitError("You're uploading too quickly. Please wait a moment and try again.");
    }
    const maxBytes = planLimits().uploads.maxBytes;
    if (Number(c.req.header("content-length") ?? "0") > maxBytes + MULTIPART_OVERHEAD_BYTES) {
      throw new AppError(413, "upload_too_large", "This file is too large.", { maxBytes });
    }
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw new ValidationError("Upload one file as multipart form data.");
    }
    const routeValue = form.get("route");
    const route = typeof routeValue === "string" ? routeValue.trim() : "";
    if (!PLUGIN_URL_NAME_PATTERN.test(route)) throw new ValidationError("route names one of the app's admin routes.");
    const file = form.get("file");
    if (!file || typeof file === "string") throw new ValidationError("Choose a file to upload.");

    // The form's own route: an active app's declared write, and what it needs of staff.
    const db = c.get("db");
    const installation = await getActivePluginInstallation(db, pluginId);
    if (!installation?.grant) throw new NotFoundError("This app is not available.");
    const declared = installation.manifest.routes.admin.find((entry) => entry.name === route);
    if (!declared || !declared.methods.some((method) => WRITE_METHODS.has(method))) throw new NotFoundError("The app has no such form route.");
    const staffPermissions = c.get("adminPermissions") as ReadonlySet<string> | undefined;
    if (declared.scope && (!installation.grant.scopes.includes(declared.scope) || !staffPermissions?.has(PLUGIN_SCOPES[declared.scope].staff))) {
      throw new ForbiddenError("You do not have permission to perform this action.");
    }
    if (file.size > maxBytes) throw new AppError(400, "upload_too_large", "This file is too large.", { maxBytes });

    const upload = await stageAppUpload(db, c.env.BUCKET, {
      appId: pluginId,
      route,
      maxBytes,
      filename: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
      uploaderKey: await appUploadStaffKey(c.env, staffId),
    });
    return created(c, { upload });
  });
}
