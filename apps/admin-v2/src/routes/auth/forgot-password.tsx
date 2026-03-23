import { createFileRoute } from "@tanstack/react-router";
import { AuthCard } from "~/components/auth/AuthCard";
import { redirectIfAuthenticated } from "~/lib/auth.fns";

export const Route = createFileRoute("/auth/forgot-password")({
  beforeLoad: () => redirectIfAuthenticated(),
  head: () => ({
    meta: [{ title: "Forgot Password - Scalius Admin" }],
  }),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  return <AuthCard view="FORGOT_PASSWORD" redirectTo="/admin" />;
}
