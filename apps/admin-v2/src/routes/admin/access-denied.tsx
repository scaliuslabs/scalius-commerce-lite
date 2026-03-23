import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";

export const Route = createFileRoute("/admin/access-denied")({
  head: () => ({ meta: [{ title: "Access Denied | Scalius Admin" }] }),
  component: AccessDeniedPage,
});

function AccessDeniedPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="rounded-full bg-destructive/10 p-6 mb-6">
        <ShieldAlert className="w-12 h-12 text-destructive" strokeWidth={1.5} />
      </div>
      <h1 className="text-2xl font-semibold text-foreground mb-2">Access Denied</h1>
      <p className="text-muted-foreground mb-6 max-w-md">
        You don't have permission to access this page. Contact your administrator if you believe this is an error.
      </p>
      <Link
        to="/admin"
        className="inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors"
      >
        Go to Dashboard
      </Link>
    </div>
  );
}
