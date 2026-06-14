import { createFileRoute, redirect } from "@tanstack/react-router";
import { SetupForm } from "~/components/auth/SetupForm";
import { checkAdminExists } from "~/lib/auth.fns";

export const Route = createFileRoute("/auth/setup")({
  beforeLoad: async () => {
    // Only accessible when no admin users exist in the shared Better Auth D1 database.
    const adminExists = await checkAdminExists();
    if (adminExists) {
      throw redirect({ to: "/auth/login" });
    }
  },
  head: () => ({
    meta: [{ title: "Setup - Scalius Admin" }],
  }),
  component: SetupPage,
});

function SetupPage() {
  return <SetupForm />;
}
