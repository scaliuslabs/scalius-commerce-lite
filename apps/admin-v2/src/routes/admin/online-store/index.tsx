import { createFileRoute, redirect } from "@tanstack/react-router";
import { canAccessAdminPath } from "~/lib/admin-access";

// The section has no page of its own: open its first page the merchant may see.
export const Route = createFileRoute("/admin/online-store/")({
  beforeLoad: async ({ context }) => {
    const { ADMIN_NAV } = await import("~/components/admin/layout/AdminNav");
    const pages = ADMIN_NAV.find((item) => item.key === "onlineStore")?.children ?? [];
    const first = pages.find((page) => canAccessAdminPath(page.to, context));
    throw redirect({ to: first?.to ?? "/admin/access-denied", replace: true });
  },
});
