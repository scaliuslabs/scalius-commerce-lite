import { createFileRoute } from "@tanstack/react-router";
import { LoginForm } from "~/components/auth/LoginForm";
import { loginPageGuard } from "~/lib/auth-guards";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/auth/login")({
  beforeLoad: () => loginPageGuard(),
  head: () => pageHead("signIn"),
  component: LoginPage,
});

function LoginPage() {
  const { signIn, signedOut } = Route.useRouteContext();
  return <LoginForm signIn={signIn} signedOut={signedOut} />;
}
