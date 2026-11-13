import { createFileRoute } from "@tanstack/react-router";
import { LoginForm } from "~/components/auth/LoginForm";
import { loginPageGuard } from "~/lib/auth-guards";
import { signInReturnSearch } from "~/lib/sign-in-return";
import { pageHead } from "~/i18n/page-titles";

export const Route = createFileRoute("/auth/login")({
  // `next`: the dashboard page sign-in returns to (validated: never another site).
  validateSearch: signInReturnSearch,
  beforeLoad: ({ search }) => loginPageGuard(search.next),
  head: () => pageHead("signIn"),
  component: LoginPage,
});

function LoginPage() {
  const { signIn, signedOut } = Route.useRouteContext();
  const { next } = Route.useSearch();
  return <LoginForm signIn={signIn} signedOut={signedOut} next={next} />;
}
