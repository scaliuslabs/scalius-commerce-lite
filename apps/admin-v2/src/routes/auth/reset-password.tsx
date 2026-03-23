import { createFileRoute } from "@tanstack/react-router";
import { AuthCard } from "~/components/auth/AuthCard";

export const Route = createFileRoute("/auth/reset-password")({
  head: () => ({
    meta: [{ title: "Reset Password - Scalius Admin" }],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  return <AuthCard view="RESET_PASSWORD" redirectTo="/auth/login" />;
}
