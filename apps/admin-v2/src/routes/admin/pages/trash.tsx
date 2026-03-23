import { createFileRoute, redirect } from "@tanstack/react-router";

// Pages trash is now handled by the main pages route via ?trashed=true
export const Route = createFileRoute("/admin/pages/trash")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/pages", search: { trashed: true } });
  },
  component: () => null,
});
