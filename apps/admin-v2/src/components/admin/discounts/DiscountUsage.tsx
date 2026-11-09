import { Link } from "@tanstack/react-router";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";

/**
 * "Used N times". A code discount that was used links to the orders that
 * redeemed its saved code (the orders list's discount-code filter, one core
 * query with the app API's `orders.list?discountCode=`), for staff who may
 * view orders. An automatic discount has no code to filter by.
 */
export function DiscountUsage({ code, count }: { code: string | null; count: number }) {
  const t = useMessages(discountsMessages);
  const { hasPermission } = usePermissions();
  const text = t("performance", { count });
  const linkable = code !== null && code.trim() !== "" && count > 0 && hasPermission(ADMIN_PERMISSIONS.ORDERS_VIEW);
  if (!linkable) return <>{text}</>;
  return (
    <Link to="/admin/orders" search={{ discountCode: code.trim().toUpperCase() } as never} className="text-link hover:underline">
      {text}
    </Link>
  );
}
