import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { withDashboardBasePath } from "@/lib/dashboard-base-path";
import { storePendingTwoFactorMethods } from "@/lib/two-factor-pending";
import { useMessages } from "~/i18n";
import { authMessages, type AuthMessageKey } from "~/i18n/auth";
import { authFailureMessage, newPasswordError, readAuthFailure, type AuthMessage } from "./auth-error";
import { AuthAlert, AuthHeader, Field, PasswordInput, describedBy, linkClassName } from "./auth-ui";

type Step = "checking" | "form" | "expired" | "done";
type Purpose = "invite" | "reset";

interface LinkCheck {
  ready: boolean;
  purpose: Purpose;
}

/**
 * The reset or invite link carries its one-time proof in the URL fragment,
 * which the browser never sends to a server or in a Referer. It is removed
 * from the address bar at once and exchanged for a short-lived HttpOnly
 * cookie; the server checks the link then, so a used or expired one never
 * shows the form. The new password is then posted on its own.
 */
function exchangeLinkProof(): Promise<LinkCheck> {
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const invite = fragment.get("invite");
  const token = invite ?? fragment.get("token");
  const fallback: LinkCheck = { ready: false, purpose: invite ? "invite" : "reset" };
  window.history.replaceState(null, "", window.location.pathname);
  if (!token) return Promise.resolve(fallback);
  return fetch(withDashboardBasePath("/api/auth/reset-session"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  })
    .then(async (response) => {
      if (!response.ok) return fallback;
      const body = (await response.json().catch(() => null)) as { purpose?: unknown } | null;
      return { ready: true, purpose: body?.purpose === "invite" ? "invite" : "reset" } satisfies LinkCheck;
    })
    .catch(() => fallback);
}

export function ResetPasswordForm() {
  const t = useMessages(authMessages);
  const navigate = useNavigate();
  const passwordRef = useRef<HTMLInputElement>(null);
  const exchange = useRef<Promise<LinkCheck> | null>(null);
  const [step, setStep] = useState<Step>("checking");
  const [purpose, setPurpose] = useState<Purpose>("reset");
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<AuthMessageKey | null>(null);
  const [failure, setFailure] = useState<AuthMessage | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // The link's purpose is only known in the browser (it lives in the
  // fragment), so the tab title follows it once the link is checked.
  useEffect(() => {
    document.title = `${t(purpose === "invite" ? "inviteTitle" : "resetTitle")} · Scalius`;
  }, [purpose, t]);

  useEffect(() => {
    let active = true;
    const check = () => {
      // One exchange per link, even when React mounts the effect twice.
      exchange.current ??= exchangeLinkProof();
      void exchange.current.then((result) => {
        if (!active) return;
        setPurpose(result.purpose);
        setStep(result.ready ? "form" : "expired");
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
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        // The server signed the person in with the new password: go on to two-step
        // verification (or its first-time setup, which the dashboard guard opens).
        const result = body as { signedIn?: boolean; twoFactorRedirect?: boolean; twoFactorMethods?: readonly unknown[] } | null;
        if (result?.twoFactorRedirect) {
          storePendingTwoFactorMethods(result.twoFactorMethods);
          await navigate({ to: "/auth/two-factor", replace: true });
        } else if (result?.signedIn) {
          await navigate({ to: "/admin", replace: true });
        } else {
          setStep("done");
        }
        return;
      }
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
    return purpose === "invite" ? (
      <div className="flex flex-col gap-6">
        <AuthHeader title={t("inviteExpiredTitle")} description={t("inviteExpiredBody")} />
        <Link to="/auth/login" className={linkClassName}>
          {t("backToSignIn")}
        </Link>
      </div>
    ) : (
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

  const invite = purpose === "invite";
  const passwordMessage = fieldError ? t(fieldError) : null;
  return (
    <div className="flex flex-col gap-6">
      <AuthHeader title={t(invite ? "inviteTitle" : "resetTitle")} description={t(invite ? "inviteDescription" : "resetDescription")} />
      <form method="post" action="/auth/reset-password" onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <AuthAlert message={failure} />
        <Field id="new-password" label={t(invite ? "password" : "newPassword")} error={passwordMessage} hint={t("passwordHint")}>
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
          {t(invite ? "setUpAccount" : "savePassword")}
        </Button>
      </form>
    </div>
  );
}
