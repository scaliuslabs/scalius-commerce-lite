import { useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Check, Copy } from "lucide-react";
import { postApiV1AdminAuth2FaMethod } from "@scalius/api-client/sdk";
import { apiData } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useMessages } from "~/i18n";
import { authMessages, type AuthMessageKey } from "~/i18n/auth";
import { authFailureMessage, type AuthMessage } from "./auth-error";
import {
  AuthAlert,
  AuthHeader,
  CodeInput,
  Field,
  PasswordInput,
  SignOutButton,
  describedBy,
  linkClassName,
  useResendCooldown,
} from "./auth-ui";

type Step = "password" | "verify" | "backup";

// Better Auth loads on the first action, keeping it out of this route's chunk.
async function loadTwoFactorClient() {
  const { authClient } = await import("@/lib/auth-client");
  return authClient.twoFactor;
}

/**
 * First sign-in when the store requires two-step verification: confirm the
 * password, prove the email code arrives, then save the backup codes.
 */
export function TwoFactorSetup({ userEmail }: { userEmail: string }) {
  const t = useMessages(authMessages);
  const navigate = useNavigate();
  const busy = useRef(false);
  const [step, setStep] = useState<Step>("password");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [savedCodes, setSavedCodes] = useState(false);
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const [fieldError, setFieldError] = useState<AuthMessageKey | null>(null);
  const [failure, setFailure] = useState<AuthMessage | null>(null);
  const [notice, setNotice] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const { seconds: resendIn, start: startCooldown, reset: resetCooldown } = useResendCooldown();

  function fail(error: unknown, pick: (code: string, status: number | null) => AuthMessageKey | null) {
    setFailure(authFailureMessage(error, ({ code: errorCode, status }) => pick(errorCode, status)));
  }

  async function sendCode(announce: boolean) {
    setFailure(null);
    setNotice(false);
    startCooldown();
    try {
      const { error } = await (await loadTwoFactorClient()).sendOtp();
      if (!error) return setNotice(announce);
      fail(error, () => "sendFailed");
    } catch (error) {
      fail(error, () => "sendFailed");
    }
    resetCooldown();
  }

  async function confirmPassword() {
    if (!password) return setFieldError("passwordRequired");
    setIsLoading(true);
    try {
      const twoFactor = await loadTwoFactorClient();
      // A TOTP enrolment is what creates the backup codes; the email method is confirmed next.
      const { data, error } = await twoFactor.enable({ password, method: "totp" });
      if (error || data?.method !== "totp") {
        setPassword("");
        return fail(error, (errorCode, status) =>
          errorCode === "INVALID_PASSWORD" || status === 400 || status === 401 ? "incorrectPassword" : null,
        );
      }
      setBackupCodes(data.backupCodes);
      setPassword("");
      setStep("verify");
      await sendCode(false);
    } catch (error) {
      fail(error, () => null);
    } finally {
      setIsLoading(false);
    }
  }

  // The sixth digit submits before React re-renders, so the code arrives as an argument.
  async function verifyCode(entered: string) {
    if (entered.length !== 6) return setFieldError("codeIncomplete");
    setIsLoading(true);
    try {
      await apiData(postApiV1AdminAuth2FaMethod({ body: { method: "email", code: entered } }));
      setStep("backup");
    } catch (error) {
      fail(error, (errorCode, status) =>
        errorCode === "OTP_HAS_EXPIRED" ? "codeExpired" : status === 400 || status === 401 ? "codeInvalid" : null,
      );
      setCode("");
      document.getElementById("setup-code")?.focus();
    } finally {
      setIsLoading(false);
    }
  }

  function run(action: () => Promise<unknown>) {
    if (busy.current) return;
    busy.current = true;
    setFieldError(null);
    setFailure(null);
    setNotice(false);
    void action().finally(() => {
      busy.current = false;
    });
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    run(step === "password" ? confirmPassword : () => verifyCode(code));
  }

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(backupCodes.join("\n"));
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  }

  if (step === "backup") {
    return (
      <div className="flex flex-col gap-6">
        <AuthHeader title={t("backupCodesTitle")} description={t("backupCodesDescription")} />
        <div className="flex flex-col gap-3 rounded-lg bg-muted p-4">
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-body tabular-nums">
            {backupCodes.map((backupCode) => (
              <li key={backupCode}>{backupCode}</li>
            ))}
          </ul>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={() => void copyCodes()}>
              {copied === "yes" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied === "yes" ? t("copied") : t("copyCodes")}
            </Button>
            {copied === "failed" ? (
              <p role="status" className="text-body text-destructive">
                {t("copyFailed")}
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="saved-codes" checked={savedCodes} onCheckedChange={(checked) => setSavedCodes(checked === true)} />
          <label htmlFor="saved-codes" className="text-body">
            {t("savedCodes")}
          </label>
        </div>
        <Button className="w-full" disabled={!savedCodes} onClick={() => void navigate({ to: "/admin", replace: true })}>
          {t("continueToDashboard")}
        </Button>
      </div>
    );
  }

  const message = fieldError ? t(fieldError) : null;
  return (
    <div className="flex flex-col gap-6">
      {step === "password" ? (
        <AuthHeader title={t("setupTwoFactorTitle")} description={t("setupTwoFactorDescription", { email: userEmail })} />
      ) : (
        <AuthHeader title={t("checkEmailTitle")} description={t("emailDescription", { email: userEmail })} />
      )}
      <form method="post" action="/auth/setup-2fa" onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <AuthAlert message={failure} />
        {step === "password" ? (
          <Field id="setup-password" label={t("password")} error={message}>
            <PasswordInput
              id="setup-password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                setFieldError(null);
              }}
              {...describedBy("setup-password", message)}
            />
          </Field>
        ) : (
          <>
            <Field id="setup-code" label={t("codeLabel")} error={message}>
              <CodeInput
                id="setup-code"
                value={code}
                autoFocus
                invalid={Boolean(message)}
                describedById={message ? "setup-code-message" : undefined}
                onChange={(next) => {
                  setCode(next);
                  setFieldError(null);
                }}
                onComplete={(full) => run(() => verifyCode(full))}
              />
            </Field>
            <p className="text-body text-muted-foreground" aria-live="polite">
              {notice ? `${t("codeSent")} ` : null}
              {resendIn > 0 ? (
                t("resendIn", { count: resendIn })
              ) : (
                <button type="button" className={linkClassName} onClick={() => void sendCode(true)}>
                  {t("resendCode")}
                </button>
              )}
            </p>
          </>
        )}
        <Button type="submit" className="w-full" loading={isLoading}>
          {step === "password" ? t("sendCode") : t("verify")}
        </Button>
      </form>
      <div>
        <SignOutButton />
      </div>
    </div>
  );
}
