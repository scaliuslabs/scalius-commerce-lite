import { createFileRoute } from "@tanstack/react-router";
import { ResetPasswordForm } from "~/components/auth/ResetPasswordForm";
import { translate } from "~/i18n";
import { authMessages } from "~/i18n/auth";

export const Route = createFileRoute("/auth/reset-password")({
  head: () => ({ meta: [{ title: `${translate(authMessages, "resetTitle")} · Scalius` }] }),
  component: ResetPasswordForm,
});
