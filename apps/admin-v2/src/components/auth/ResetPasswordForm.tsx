import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { withDashboardBasePath } from "@/lib/dashboard-base-path";
import { useMessages } from "~/i18n";
import { authMessages, type AuthMessageKey } from "~/i18n/auth";
import { authFailureMessage, newPasswordError, readAuthFailure, type AuthMessage } from "./auth-error";
import { AuthAlert, AuthHeader, Field, PasswordInput, describedBy, linkClassName } from "./auth-ui";

type Step = "checking" | "form" | "expired" | "done";

/**
 * The reset link carries its one-time proof in the URL fragment, which the
 * browser never sends to a server or in a Referer. It is removed from the
 * address bar at once and exchanged for a short-lived HttpOnly cookie; the
 * new password is then posted on its own.
 */
function exchangeResetProof(): Promise<boolean> {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
  window.history.replaceState(null, "", window.location.pathname);
  if (!token) return Promise.resolve(false);
  return fetch(withDashboardBasePath("/api/auth/reset-session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  })
    .then((response) => response.ok)
    .catch(() => false);
}

export function ResetPasswordForm() {
  const t = useMessages(authMessages);
  const passwordRef = useRef<HTMLInputElement>(null);
  const exchange = useRef<Promise<boolean> | null>(null);
  const [step, setStep] = useState<Step>("checking");
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<AuthMessageKey | null>(null);
  const [failure, setFailure] = useState<AuthMessage | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    let active = true;
    const check = () => {
      // One exchange per link, even when React mounts the effect twice.
      exchange.current ??= exchangeResetProof();
      void exchange.current.then((ready) => {
        if (active) setStep(ready ? "form" : "expired");
      });
    };
    // A new link opened in this same tab only changes the fragment.
    const onHashChange = () => {
      if (!window.location.hash) return;
      exchange.current = null;
      setStep("checking");
      check();
    };
    check();
    window.addEventListener("hashchange", onHashChange);
    return () => {
      active = false;
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isLoading) return;
    const error = newPasswordError(password);
    setFieldError(error);
    setFailure(null);
    if (error) return passwordRef.current?.focus();

    setIsLoading(true);
    try {
      const response = await fetch(withDashboardBasePath("/api/auth/reset-password-session"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: password }),
      });
      if (response.ok) {
        setStep("done");
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      const { code } = readAuthFailure({ status: response.status, error: body });
      if (code === "INVALID_TOKEN" || code === "INVALID_RESET_SESSION") return setStep("expired");
      if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG") {
        setFieldError(code === "PASSWORD_TOO_SHORT" ? "passwordTooShort" : "passwordTooLong");
        return passwordRef.current?.focus();
      }
      setFailure(authFailureMessage({ status: response.status }, () => null, response.headers.get("X-Retry-After")));
    } catch (requestError) {
      setFailure(authFailureMessage(requestError, () => null));
    } finally {
      setPassword("");
      setIsLoading(false);
    }
  }

  if (step === "checking") {
    return (
      <div role="status" className="flex items-center gap-2 py-8 text-body text-muted-foreground">
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        {t("checkingLink")}
      </div>
    );
  }

  if (step === "expired") {
    return (
      <div className="flex flex-col gap-6">
        <AuthHeader title={t("linkExpiredTitle")} description={t("linkExpiredBody")} />
        <Button asChild className="w-full">
          <Link to="/auth/forgot-password">{t("requestNewLink")}</Link>
        </Button>
        <Link to="/auth/login" className={linkClassName}>
          {t("backToSignIn")}
        </Link>
      </div>
    );
  }

  if (step === "done") {
    return (
      <div className="flex flex-col gap-6">
        <AuthHeader title={t("passwordChangedTitle")} description={t("passwordChangedBody")} />
        <Button asChild className="w-full">
          <Link to="/auth/login" replace>
            {t("signIn")}
          </Link>
        </Button>
      </div>
    );
  }

  const passwordMessage = fieldError ? t(fieldError) : null;
  return (
    <div className="flex flex-col gap-6">
      <AuthHeader title={t("resetTitle")} description={t("resetDescription")} />
      <form method="post" action="/auth/reset-password" onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <AuthAlert message={failure} />
        <Field id="new-password" label={t("newPassword")} error={passwordMessage} hint={t("passwordHint")}>
          <PasswordInput
            ref={passwordRef}
            id="new-password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setFieldError(null);
            }}
            {...describedBy("new-password", passwordMessage, t("passwordHint"))}
          />
        </Field>
        <Button type="submit" className="w-full" loading={isLoading}>
          {t("savePassword")}
        </Button>
      </form>
    </div>
  );
}
