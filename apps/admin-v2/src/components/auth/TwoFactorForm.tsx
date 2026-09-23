import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { getApiV1AdminAuth2FaInfo } from "@scalius/api-client/sdk";
import { authClient } from "@/lib/auth-client";
import { apiData } from "@/lib/api";
import {
  chooseInitialTwoFactorMethod,
  clearPendingTwoFactorMethods,
  getPreferredMethod,
  readPendingTwoFactorMethods,
  type VerifyTwoFactorMethod,
} from "@/lib/two-factor-pending";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMessages } from "~/i18n";
import { authMessages, type AuthMessageKey } from "~/i18n/auth";
import { authFailureMessage, type AuthFailure, type AuthMessage } from "./auth-error";
import {
  AuthAlert,
  AuthHeader,
  CodeInput,
  Field,
  SignOutButton,
  describedBy,
  linkClassName,
  useResendCooldown,
} from "./auth-ui";

const METHOD_LINKS: Record<VerifyTwoFactorMethod, AuthMessageKey> = {
  totp: "useAuthenticator",
  email: "useEmail",
  backup: "useBackup",
};

function codeFailure({ code, status }: AuthFailure, method: VerifyTwoFactorMethod): AuthMessageKey | null {
  if (code === "INVALID_TWO_FACTOR_COOKIE") return "signInExpired";
  if (code === "OTP_HAS_EXPIRED") return "codeExpired";
  if (code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE") return "codeTooManyAttempts";
  if (code.startsWith("INVALID") || status === 400 || status === 401) {
    return method === "backup" ? "backupInvalid" : "codeInvalid";
  }
  return null;
}

/**
 * The second sign-in step. Offers the methods the account has (from the
 * sign-in response, or the account's preference) plus backup codes. Email
 * codes are sent on arrival; a new one can be requested after 30 seconds.
 */
export function TwoFactorForm() {
  const t = useMessages(authMessages);
  const navigate = useNavigate();
  const busy = useRef(false);
  const backupRef = useRef<HTMLInputElement>(null);
  const [pendingMethods] = useState(readPendingTwoFactorMethods);
  const [method, setMethod] = useState<VerifyTwoFactorMethod>(() =>
    chooseInitialTwoFactorMethod({ pendingMethods }),
  );
  const [ready, setReady] = useState(pendingMethods.length > 0);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [fieldError, setFieldError] = useState<AuthMessageKey | null>(null);
  const [failure, setFailure] = useState<AuthMessage | null>(null);
  const [notice, setNotice] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const { seconds: resendIn, start: startCooldown, reset: resetCooldown } = useResendCooldown();
  const autoSent = useRef(false);

  const sendEmailCode = useCallback(
    async (announce: boolean) => {
      setFailure(null);
      setNotice(false);
      startCooldown();
      const failed = (error: unknown) => {
        setFailure(authFailureMessage(error, (failure) => codeFailure(failure, "email") ?? "sendFailed"));
        resetCooldown();
      };
      try {
        const { error } = await authClient.twoFactor.sendOtp();
        if (error) return failed(error);
        setNotice(announce);
      } catch (error) {
        failed(error);
      }
    },
    [startCooldown, resetCooldown],
  );

  useEffect(() => {
    if (ready) return;
    // Arrived without the sign-in response (a reload): ask the account which method it prefers.
    let active = true;
    apiData(getApiV1AdminAuth2FaInfo())
      .then((info) => {
        if (!active) return;
        if (info.method) setMethod(getPreferredMethod(info.method));
        setEmail(info.email || "");
      })
      .catch(() => {
        // The default method still works; the account lookup is only a preference.
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, [ready]);

  useEffect(() => {
    if (!ready || method !== "email" || autoSent.current) return;
    autoSent.current = true;
    void sendEmailCode(false);
  }, [ready, method, sendEmailCode]);

  function switchMethod(next: VerifyTwoFactorMethod) {
    setMethod(next);
    setCode("");
    setFieldError(null);
    setFailure(null);
    setNotice(false);
  }

  // The sixth digit submits before React re-renders, so the code arrives as an argument.
  async function verify(entered: string) {
    if (busy.current) return;
    const typed = entered.trim();
    const missing = method === "backup" ? (typed ? null : "backupRequired") : typed.length === 6 ? null : "codeIncomplete";
    setFieldError(missing);
    setFailure(null);
    setNotice(false);
    if (missing) return;

    busy.current = true;
    setIsLoading(true);
    const failed = (error: unknown) => {
      setFailure(authFailureMessage(error, (failure) => codeFailure(failure, method)));
      setCode("");
      busy.current = false;
      setIsLoading(false);
      (method === "backup" ? backupRef.current : document.getElementById("code"))?.focus();
    };
    try {
      // Trusted devices stay off: every sign-in asks for the second step.
      const body = { code: typed, trustDevice: false };
      const { error } =
        method === "backup"
          ? await authClient.twoFactor.verifyBackupCode(body)
          : method === "email"
            ? await authClient.twoFactor.verifyOtp(body)
            : await authClient.twoFactor.verifyTotp(body);
      if (error) return failed(error);
      clearPendingTwoFactorMethods();
      await navigate({ to: "/admin", replace: true });
    } catch (error) {
      failed(error);
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void verify(code);
  }

  const title = t("twoFactorTitle");
  if (!ready) {
    return (
      <div className="flex flex-col gap-6">
        <AuthHeader title={title} />
        <div role="status" aria-label={t("codeLabel")} className="flex justify-center py-6">
          <Loader2 aria-hidden="true" className="size-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const description =
    method === "totp"
      ? t("totpDescription")
      : method === "backup"
        ? t("backupDescription")
        : email
          ? t("emailDescription", { email })
          : t("emailDescriptionGeneric");
  const codeMessage = fieldError ? t(fieldError) : null;
  // Only the methods this account has, plus backup codes, which every account gets.
  const available: VerifyTwoFactorMethod[] = pendingMethods.length > 0 ? [...pendingMethods, "backup"] : ["totp", "email", "backup"];

  return (
    <div className="flex flex-col gap-6">
      <AuthHeader title={title} description={description} />
      <form method="post" action="/auth/two-factor" onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <AuthAlert message={failure}>
          {failure?.key === "signInExpired" ? <SignOutButton label="backToSignIn" /> : null}
        </AuthAlert>
        {method === "backup" ? (
          <Field id="backup-code" label={t("backupCodeLabel")} error={codeMessage}>
            <Input
              ref={backupRef}
              id="backup-code"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
                setFieldError(null);
              }}
              {...describedBy("backup-code", codeMessage)}
            />
          </Field>
        ) : (
          <Field id="code" label={t("codeLabel")} error={codeMessage}>
            <CodeInput
              key={method}
              id="code"
              value={code}
              autoFocus
              invalid={Boolean(codeMessage)}
              describedById={codeMessage ? "code-message" : undefined}
              onChange={(next) => {
                setCode(next);
                setFieldError(null);
              }}
              onComplete={(full) => void verify(full)}
            />
          </Field>
        )}
        {method === "email" ? (
          <p className="text-body text-muted-foreground" aria-live="polite">
            {notice ? `${t("codeSent")} ` : null}
            {resendIn > 0 ? (
              t("resendIn", { count: resendIn })
            ) : (
              <button type="button" className={linkClassName} onClick={() => void sendEmailCode(true)}>
                {t("resendCode")}
              </button>
            )}
          </p>
        ) : null}
        <Button type="submit" className="w-full" loading={isLoading}>
          {t("verify")}
        </Button>
      </form>
      <div className="flex flex-col items-start gap-2 border-t pt-4">
        {available
          .filter((option) => option !== method)
          .map((option) => (
            <button key={option} type="button" className={linkClassName} onClick={() => switchMethod(option)}>
              {t(METHOD_LINKS[option])}
            </button>
          ))}
        <SignOutButton label="useAnotherAccount" />
      </div>
    </div>
  );
}
