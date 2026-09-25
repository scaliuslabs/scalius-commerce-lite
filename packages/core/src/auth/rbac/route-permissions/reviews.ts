// Route permissions for the review moderation API (Wave B design §7.2).
// Staff never author or edit buyer text: the only writes are status, reason
// and reply, the review settings, plus opening a private thread with the
// reviewer (which also needs conversations.reply).
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const REVIEW_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/reviews": {
    GET: { permission: PERMISSIONS.REVIEWS_VIEW },
  },
  "/api/v1/admin/reviews/summary": {
    GET: { permission: PERMISSIONS.REVIEWS_VIEW },
  },
  "/api/v1/admin/reviews/settings": {
    GET: { permission: PERMISSIONS.REVIEWS_VIEW },
    PUT: { permission: PERMISSIONS.REVIEWS_MODERATE },
  },
  "/api/v1/admin/reviews/moderate": {
    POST: { permission: PERMISSIONS.REVIEWS_MODERATE },
  },
  "/api/v1/admin/reviews/*": {
    GET: { permission: PERMISSIONS.REVIEWS_VIEW },
  },
  "/api/v1/admin/reviews/*/reply": {
    PUT: { permission: PERMISSIONS.REVIEWS_MODERATE },
  },
  "/api/v1/admin/reviews/*/conversation": {
    POST: { allOf: [PERMISSIONS.REVIEWS_MODERATE, PERMISSIONS.CONVERSATIONS_REPLY] },
  },
};
