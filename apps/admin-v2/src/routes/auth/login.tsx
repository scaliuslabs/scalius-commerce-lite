import { createFileRoute } from "@tanstack/react-router";
import { LoginForm } from "~/components/auth/LoginForm";
import { translate } from "~/i18n";
import { authMessages } from "~/i18n/auth";
import { loginPageGuard } from "~/lib/auth-guards";

export const Route = createFileRoute("/auth/login")({
  beforeLoad: () => loginPageGuard(),
  head: () => ({ meta: [{ title: `${translate(authMessages, "signInTitle")} · Scalius` }] }),
  component: LoginPage,
});

function LoginPage() {
  const { signIn } = Route.useRouteContext();
  return <LoginForm signIn={signIn} />;
}
