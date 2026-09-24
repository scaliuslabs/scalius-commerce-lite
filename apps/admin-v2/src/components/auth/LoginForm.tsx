import { useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";
import { storePendingTwoFactorMethods } from "@/lib/two-factor-pending";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useMessages } from "~/i18n";
import { authMessages, type AuthMessageKey } from "~/i18n/auth";
import { authFailureMessage, emailError, type AuthMessage } from "./auth-error";
import { AuthAlert, AuthHeader, Field, PasswordInput, describedBy, linkClassName } from "./auth-ui";

export interface LoginFormSignInFacts {
  /** Password sign-in is switched off while an identity provider owns sign-in. */
  localLoginDisabled: boolean;
  identityHandoffEnabled: boolean;
}

export function LoginForm({ signIn }: { signIn?: LoginFormSignInFacts }) {
  const t = useMessages(authMessages);
  if (signIn?.localLoginDisabled) {
    // The operator's identity provider opens the dashboard; there is nothing to type here.
    return (
      <div className="flex flex-col gap-4">
        <AuthHeader title={t("signInTitle")} description={t("ssoDescription")} />
        <p role="status" className="text-body">
          {t("ssoBody")}
        </p>
      </div>
    );
  }
  return <PasswordLoginForm />;
}

function PasswordLoginForm() {
  const t = useMessages(authMessages);
  const navigate = useNavigate();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [fieldErrors, setFieldErrors] = useState<{ email?: AuthMessageKey | null; password?: AuthMessageKey | null }>({});
  const [failure, setFailure] = useState<AuthMessage | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    // The form never submits natively: credentials must not reach a URL or the server as form data.
    event.preventDefault();
    if (isLoading) return;
    const errors = { email: emailError(email), password: password ? null : ("passwordRequired" as const) };
    setFieldErrors(errors);
    setFailure(null);
    if (errors.email) return emailRef.current?.focus();
    if (errors.password) return passwordRef.current?.focus();

    setIsLoading(true);
    let retryAfter: string | null = null;
    const fail = (error: unknown) => {
      const message = authFailureMessage(
        error,
        ({ status, code }) =>
          code === "BANNED_USER" ? "suspended" : status === 400 || status === 401 ? "invalidCredentials" : null,
        retryAfter,
      );
      setFailure(message);
      setIsLoading(false);
      if (message.key === "invalidCredentials") {
        setPassword("");
        passwordRef.current?.focus();
      }
    };
    try {
      const { data, error } = await authClient.signIn.email({
        email: email.trim(),
        password,
        rememberMe,
        fetchOptions: {
          onError: ({ response }) => {
            retryAfter = response.headers.get("X-Retry-After");
          },
        },
      });
      if (error) return fail(error);
      const result = data as { twoFactorRedirect?: boolean; twoFactorMethods?: readonly unknown[] } | null;
      if (result?.twoFactorRedirect) {
        storePendingTwoFactorMethods(result.twoFactorMethods);
        await navigate({ to: "/auth/two-factor", replace: true });
        return;
      }
      await navigate({ to: "/admin", replace: true });
    } catch (error) {
      fail(error);
    }
  }

  const emailMessage = fieldErrors.email ? t(fieldErrors.email) : null;
  const passwordMessage = fieldErrors.password ? t(fieldErrors.password) : null;

  return (
    <div className="flex flex-col gap-6">
      <AuthHeader title={t("signInTitle")} description={t("signInDescription")} />
      <form method="post" action="/auth/login" onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <AuthAlert message={failure} />
        <Field id="email" label={t("email")} error={emailMessage}>
          <Input
            ref={emailRef}
            id="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              if (fieldErrors.email) setFieldErrors((current) => ({ ...current, email: null }));
            }}
            onBlur={() => {
              if (email.trim()) setFieldErrors((current) => ({ ...current, email: emailError(email) }));
            }}
            {...describedBy("email", emailMessage)}
          />
        </Field>
        <Field id="password" label={t("password")} error={passwordMessage}>
          <PasswordInput
            ref={passwordRef}
            id="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              if (fieldErrors.password) setFieldErrors((current) => ({ ...current, password: null }));
            }}
            {...describedBy("password", passwordMessage)}
          />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-2">
            <Checkbox
              id="remember-me"
              checked={rememberMe}
              onCheckedChange={(checked) => setRememberMe(checked === true)}
            />
            <label htmlFor="remember-me" className="text-body">
              {t("keepSignedIn")}
            </label>
          </div>
          <Link to="/auth/forgot-password" className={linkClassName}>
            {t("forgotPassword")}
          </Link>
        </div>
        <Button type="submit" className="w-full" loading={isLoading}>
          {t("signIn")}
        </Button>
      </form>
    </div>
  );
}
