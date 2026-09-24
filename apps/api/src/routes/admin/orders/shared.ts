// Types and schemas shared by the dashboard order routes.
import { z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import { errorResponses, conflictResponse } from "../../../schemas/responses";

export type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
export type AdminRouteContext<R extends RouteConfig> = Parameters<AdminRouteHandler<R>>[0];

export const adminWriteErrorResponses = {
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
} as const;

export const adminOrderResourceMutationErrorResponses = {
    ...adminWriteErrorResponses,
    404: errorResponses[404],
    409: conflictResponse,
} as const;

/** One key per bulk run: running the same selection again reports what it already did as done. */
export const bulkRequestKeySchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/).optional();
