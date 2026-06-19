import { createFileRoute } from "@tanstack/react-router";
import { ResetPasswordForm } from "~/components/auth/ResetPasswordForm";

export const Route = createFileRoute("/auth/reset-password")({
  head: () => ({
    meta: [{ title: "Reset Password - Scalius Admin" }],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
