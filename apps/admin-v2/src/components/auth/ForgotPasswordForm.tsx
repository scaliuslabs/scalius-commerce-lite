import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { withDashboardBasePath } from "@/lib/dashboard-base-path";
import { useMessages } from "~/i18n";
import { authMessages, type AuthMessageKey } from "~/i18n/auth";
import { authFailureMessage, emailError, type AuthMessage } from "./auth-error";
import { AuthAlert, AuthHeader, Field, SignOutButton, describedBy, linkClassName } from "./auth-ui";

/**
 * Requests a reset link. A signed-in admin who must change their password
 * lands here too: their email is filled in and fixed, and the way out is
 * signing out rather than going back to sign in.
 */
export function ForgotPasswordForm({ signedInEmail }: { signedInEmail?: string }) {
  const t = useMessages(authMessages);
  const emailRef = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState(signedInEmail ?? "");
  const [fieldError, setFieldError] = useState<AuthMessageKey | null>(null);
  const [failure, setFailure] = useState<AuthMessage | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isLoading) return;
    const error = emailError(email);
    setFieldError(error);
    setFailure(null);
    if (error) return emailRef.current?.focus();

    setIsLoading(true);
    try {
      const response = await fetch(withDashboardBasePath("/api/auth/request-password-reset"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), redirectTo: withDashboardBasePath("/auth/reset-password") }),
      });
      // Never report a failed request as sent.
      if (!response.ok) {
        setFailure(authFailureMessage({ status: response.status }, () => null, response.headers.get("X-Retry-After")));
        return;
      }
      setSentTo(email.trim());
    } catch (requestError) {
      setFailure(authFailureMessage(requestError, () => null));
    } finally {
      setIsLoading(false);
    }
  }

  const exit = signedInEmail ? (
    <SignOutButton />
  ) : (
    <Link to="/auth/login" className={linkClassName}>
      {t("backToSignIn")}
    </Link>
  );

  if (sentTo) {
    return (
      <div className="flex flex-col gap-6">
        {/* The same answer whether or not the address has an account. */}
        <AuthHeader title={t("checkEmailTitle")} description={t("checkEmailBody", { email: sentTo })} />
        <p className="text-body text-muted-foreground">{t("checkSpam")}</p>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {exit}
          {signedInEmail ? null : (
            <button type="button" className={linkClassName} onClick={() => setSentTo(null)}>
              {t("useDifferentEmail")}
            </button>
          )}
        </div>
      </div>
    );
  }

  const emailMessage = fieldError ? t(fieldError) : null;
  return (
    <div className="flex flex-col gap-6">
      <AuthHeader
        title={t(signedInEmail ? "mustChangeTitle" : "forgotTitle")}
        description={t(signedInEmail ? "mustChangeDescription" : "forgotDescription")}
      />
      <form method="post" action="/auth/forgot-password" onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
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
            autoFocus={!signedInEmail}
            readOnly={Boolean(signedInEmail)}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setFieldError(null);
            }}
            {...describedBy("email", emailMessage)}
          />
        </Field>
        <Button type="submit" className="w-full" loading={isLoading}>
          {t("sendResetLink")}
        </Button>
      </form>
      <div>{exit}</div>
    </div>
  );
}
