import { createFileRoute } from "@tanstack/react-router";
import { LoginForm } from "~/components/auth/LoginForm";
import { loginPageGuard } from "~/lib/auth.fns";

export const Route = createFileRoute("/auth/login")({
  beforeLoad: () => loginPageGuard(),
  head: () => ({
    meta: [{ title: "Sign In - Scalius Admin" }],
  }),
  component: LoginPage,
});

function LoginPage() {
  return <LoginForm />;
}
