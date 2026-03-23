import { createFileRoute, redirect } from "@tanstack/react-router";

// Collections trash is now handled by the main collections route via ?trashed=true
export const Route = createFileRoute("/admin/collections/trash")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/collections", search: { trashed: true } });
  },
  component: () => null,
});
