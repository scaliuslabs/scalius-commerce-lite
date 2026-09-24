import { createFileRoute } from "@tanstack/react-router";
import { ResetPasswordForm } from "~/components/auth/ResetPasswordForm";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/auth/reset-password")({
  head: () => pageHead("resetPassword"),
  component: ResetPasswordForm,
});
