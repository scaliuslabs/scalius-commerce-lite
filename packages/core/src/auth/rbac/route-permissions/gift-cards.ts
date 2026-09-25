// Route permissions for the gift-card API (Wave B design §7.2). Gift cards
// issue money, so they have their own sensitive permissions and are never
// folded into orders permissions.
import { PERMISSIONS } from "../permissions";
import type { RoutePermissionMap } from "./shared";

export const GIFT_CARD_ROUTE_PERMISSIONS: RoutePermissionMap = {
  "/api/v1/admin/gift-cards": {
    GET: { permission: PERMISSIONS.GIFT_CARDS_VIEW },
    POST: { permission: PERMISSIONS.GIFT_CARDS_MANAGE },
  },
  "/api/v1/admin/gift-cards/summary": {
    GET: { permission: PERMISSIONS.GIFT_CARDS_VIEW },
  },
  "/api/v1/admin/gift-cards/*": {
    GET: { permission: PERMISSIONS.GIFT_CARDS_VIEW },
    PATCH: { permission: PERMISSIONS.GIFT_CARDS_MANAGE },
  },
  "/api/v1/admin/gift-cards/*/adjust": {
    POST: { permission: PERMISSIONS.GIFT_CARDS_MANAGE },
  },
  "/api/v1/admin/gift-cards/*/resend": {
    POST: { permission: PERMISSIONS.GIFT_CARDS_MANAGE },
  },
};
