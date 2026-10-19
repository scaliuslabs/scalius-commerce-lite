import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { AlertCircle, Copy, Download, KeyRound, Mail, Smartphone } from "lucide-react";
import { toast } from "~/lib/toast";
import { postApiV1AdminAuth2FaDisable, postApiV1AdminAuth2FaMethod, postApiV1AdminAuth2FaMethodChallenge } from "@scalius/api-client/sdk";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { Skeleton } from "~/components/ui/skeleton";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { downloadRecoveryCodes } from "~/components/auth/auth-ui";
import type { AuthFailure } from "~/components/auth/auth-error";
import { authClient } from "~/lib/auth-client";
import { apiData } from "~/lib/api";
import { refreshAdminRouteContext } from "~/lib/admin-route-context";
import { useMessages } from "~/i18n";
import { accountMessages, type AccountMessageKey } from "~/i18n/account";
import { accountFailureKey } from "./account-error";
import type { User } from "./ProfileHeader";
import { Field } from "~/components/ui/field";

type Step = "method" | "password" | "qr" | "verify" | "codes" | "off";
type Method = "totp" | "email";
/**
 * enable: first setup · change: use the other method · codes: a new
 * authenticator key and new recovery codes · off: turn it off.
 */
type Mode = "enable" | "change" | "codes" | "off";

/** The key inside the otpauth:// link in blocks of four, for people who type it instead of scanning. */
function manualKeyOf(totpUri: string | null): string | null {
  try {
    const key = totpUri ? new URL(totpUri).searchParams.get("secret") : null;
    return key ? key.match(/.{1,4}/g)!.join(" ") : null;
  } catch {
    return null;
  }
}

const wrongPassword = ({ code, status }: AuthFailure): AccountMessageKey | null =>
  code === "PASSWORD_INCORRECT" || code === "INVALID_PASSWORD" || status === 400 || status === 401 ? "wrongPassword" : null;

const METHOD_ICON = { totp: Smartphone, email: Mail } as const;

/**
 * Two-step verification card. With it on, the two ways to get a code are
 * rows, the one in use marked and the other one click away (Stripe and
 * GitHub list factors the same way); recovery codes and Turn off sit below.
 * Every change asks for the password, and each new method proves itself with
 * a code before anything changes. Nothing here is put in a URL or a log: the
 * password, the authenticator key and the codes live only in component state
 * and are cleared when the flow closes.
 */
export function TwoFactorSetup({ user, required = false }: {
  user: User;
  /** The store requires two-step verification for this person (invited staff): no Turn off. */
  required?: boolean;
}) {
  const t = useMessages(accountMessages);
  const router = useRouter();
  const [isEnabled, setIsEnabled] = useState(user.twoFactorEnabled ?? false);
  const [currentMethod, setCurrentMethod] = useState<Method>(user.twoFactorMethod === "totp" ? "totp" : "email");
  const [mode, setMode] = useState<Mode | null>(null);
  const [step, setStep] = useState<Step>("method");
  const [method, setMethod] = useState<Method>("totp");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AccountMessageKey | null>(null);
  const isChange = mode === "change" || mode === "codes";

  // The QR code is drawn locally; the key never leaves this page.
  useEffect(() => {
    setQrDataUrl(null);
    if (!totpUri) return;
    let active = true;
    void import("qrcode")
      .then(({ toDataURL }) => toDataURL(totpUri, { width: 192, margin: 2 }))
      .then((url) => active && setQrDataUrl(url))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [totpUri]);

  const close = () => {
    setMode(null);
    setStep("method");
    setPassword("");
    setCode("");
    setTotpUri(null);
    setChallengeId(null);
    setRecoveryCodes([]);
    setError(null);
  };

  const run = async (task: () => Promise<void>, pick: (failure: AuthFailure) => AccountMessageKey | null) => {
    setError(null);
    setBusy(true);
    try {
      await task();
    } catch (err) {
      setError(accountFailureKey(err, pick));
    } finally {
      setBusy(false);
    }
  };

  const sendEmailCode = async () => {
    const result = await authClient.twoFactor.sendOtp();
    if (result?.error) throw result.error;
  };

  /** First setup picks a method; a change goes straight to the password for the method it names. */
  const start = (next: Mode, target?: Method) => {
    close();
    setMode(next);
    if (next === "enable") {
      setMethod("totp");
      return;
    }
    setMethod(target ?? "totp");
    setStep(next === "off" ? "off" : "password");
    // Turning off proves the current method: an emailed code is sent at once.
    if (next === "off" && currentMethod === "email") {
      void run(sendEmailCode, () => "codeNotSent");
    }
  };

  // The password unlocks setup (first time) or a staged method change.
  const confirmPassword = () =>
    run(async () => {
      if (!isChange) {
        const result = await authClient.twoFactor.enable({ password, method: "totp" });
        if (result.error) throw result.error;
        if (!result.data || result.data.method !== "totp") throw new Error("Two-step setup returned no authenticator key");
        setTotpUri(result.data.totpURI);
        setRecoveryCodes(result.data.backupCodes || []);
        if (method === "totp") setStep("qr");
        else {
          await sendEmailCode();
          setStep("verify");
        }
        return;
      }
      const challenge = await apiData(postApiV1AdminAuth2FaMethodChallenge({ body: { method, password } }));
      setChallengeId(challenge.challengeId);
      // Changing how codes arrive keeps the current recovery codes.
      setRecoveryCodes([]);
      if (method === "totp") {
        setTotpUri(challenge.totpUri);
        setStep("qr");
      } else {
        await sendEmailCode();
        setStep("verify");
        toast.success(t("codeSent"));
      }
    }, wrongPassword);

  // The code proves the method works before anything changes.
  const verify = () =>
    run(async () => {
      if (isChange && !challengeId) return setError("setupExpired");
      const result = await apiData(postApiV1AdminAuth2FaMethod({
        body: isChange ? { method, challengeId: challengeId!, code } : { method, code },
      }));
      const issued = isChange && method === "totp" ? result.backupCodes ?? [] : recoveryCodes;
      if (isChange && method === "totp" && !issued.length) throw new Error("The new authenticator key came without recovery codes");
      setIsEnabled(true);
      setCurrentMethod(method);
      void refreshAdminRouteContext(router);
      toast.success(t(mode === "enable" ? "turnedOn" : mode === "codes" ? "codesUpdated" : "methodChanged"));
      if (issued.length) {
        setRecoveryCodes(issued);
        setPassword("");
        setCode("");
        setStep("codes");
      } else close();
    }, codeFailure(method));

  // Turning off needs the password and a code from the method in use.
  const turnOff = () =>
    run(async () => {
      await apiData(postApiV1AdminAuth2FaDisable({ body: { password, code } }));
      setIsEnabled(false);
      void refreshAdminRouteContext(router);
      toast.success(t("turnedOff"));
      close();
    }, (failure) => {
      if (failure.code === "TWO_FACTOR_REQUIRED") return "requiredByStore";
      if (failure.code === "PASSWORD_INCORRECT") return "wrongPassword";
      return codeFailure(currentMethod)(failure);
    });

  const resend = () => run(async () => {
    await sendEmailCode();
    toast.success(t("codeSent"));
  }, () => "codeNotSent");

  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join("\n"));
      toast.success(t("codesCopied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  const dirty = mode !== null && (step !== "method" || password.length > 0 || code.length > 0);
  const manualKey = manualKeyOf(totpUri);
  const methodHelp = (option: Method) => option === "totp" ? t("authenticatorAppHelp") : t("emailCodeTo", { email: user.email });

  const codeField = (codeMethod: Method) => (
    <Field id="two-step-code" label={t(codeMethod === "email" ? "enterEmailCode" : "enterAppCode")}>
      <Input
        id="two-step-code"
        value={code}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={6}
        autoFocus={step !== "off"}
        disabled={busy}
        // eslint-disable-next-line shadcn/no-restyle -- digits in a fixed-width face so the six-digit code lines up
        className="max-w-40 font-mono"
        onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
      />
      {codeMethod === "email" ? (
        <div>
          <Button type="button" variant="link" size="sm" disabled={busy} onClick={() => void resend()}>{t("resendCode")}</Button>
        </div>
      ) : null}
    </Field>
  );
  const passwordField = (
    <Field id="two-step-password" label={t("confirmYourPassword")}>
      <Input id="two-step-password" type="password" value={password} autoComplete="current-password" autoFocus disabled={busy} onChange={(event) => setPassword(event.target.value)} />
    </Field>
  );

  let content: ReactNode;
  let footer: ReactNode = null;
  if (mode === null && !isEnabled) {
    content = (
      <div className="flex items-center justify-between gap-3">
        <span className="text-body text-muted-foreground">{t("offHelp")}</span>
        <Badge>{t("off")}</Badge>
      </div>
    );
    footer = <Button type="button" onClick={() => start("enable")}>{t("turnOn")}</Button>;
  } else if (mode === null) {
    // One row per way to get a code; the one in use is marked, the other is one click away.
    content = (
      <ul className="-mx-4 divide-y divide-border border-y border-border">
        {(["totp", "email"] as const).map((option) => {
          const Icon = METHOD_ICON[option];
          const inUse = option === currentMethod;
          return (
            <li key={option} data-method={option} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <span className="flex h-lh items-center text-muted-foreground">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-body font-medium">{t(option === "totp" ? "authenticatorApp" : "emailCode")}</span>
                <span className="break-words text-body text-muted-foreground">{methodHelp(option)}</span>
              </span>
              {inUse ? (
                <Badge variant="success">{t("inUse")}</Badge>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={() => start("change", option)}>
                  {t(option === "totp" ? "useAuthenticator" : "useEmailCodes")}
                </Button>
              )}
            </li>
          );
        })}
        {currentMethod === "totp" ? (
          <li className="flex flex-wrap items-start gap-3 px-4 py-3">
            <span className="flex h-lh items-center text-muted-foreground">
              <KeyRound className="size-4" aria-hidden="true" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-body font-medium">{t("recoveryCodes")}</span>
              <span className="text-body text-muted-foreground">{t("recoveryCodesHelp")}</span>
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => start("codes", "totp")}>{t("newRecoveryCodes")}</Button>
          </li>
        ) : null}
      </ul>
    );
    footer = required ? (
      <p className="w-full text-body text-muted-foreground">{t("requiredByStore")}</p>
    ) : (
      <Button type="button" variant="outline" onClick={() => start("off")}>{t("turnOff")}</Button>
    );
  } else if (step === "method") {
    content = (
      <RadioGroup value={method} onValueChange={(value) => setMethod(value as Method)} aria-label={t("chooseMethod")}>
        {(["totp", "email"] as const).map((option) => (
          <label key={option} htmlFor={`two-step-${option}`} className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 hover:bg-accent has-data-[state=checked]:border-ring">
            <span className="flex h-lh items-center">
              <RadioGroupItem id={`two-step-${option}`} value={option} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="text-body font-medium">{t(option === "totp" ? "authenticatorApp" : "emailCode")}</span>
              <span className="break-words text-body text-muted-foreground">{methodHelp(option)}</span>
            </span>
          </label>
        ))}
      </RadioGroup>
    );
    footer = (
      <>
        <Button type="button" variant="outline" onClick={close}>{t("cancel")}</Button>
        <Button type="button" onClick={() => setStep("password")}>{t("continue")}</Button>
      </>
    );
  } else if (step === "password") {
    content = passwordField;
    footer = (
      <>
        <Button type="button" variant="outline" disabled={busy} onClick={mode === "enable" ? () => setStep("method") : close}>
          {t(mode === "enable" ? "back" : "cancel")}
        </Button>
        <Button type="submit" loading={busy} disabled={!password}>{t("continue")}</Button>
      </>
    );
  } else if (step === "off") {
    content = (
      <>
        <Alert variant="warning">
          <AlertCircle aria-hidden="true" />
          <AlertDescription>{t("turnOffWarning")}</AlertDescription>
        </Alert>
        {passwordField}
        {codeField(currentMethod)}
      </>
    );
    footer = (
      <>
        <Button type="button" variant="outline" disabled={busy} onClick={close}>{t("cancel")}</Button>
        <Button type="submit" variant="destructive" loading={busy} disabled={!password || code.length !== 6}>{t("turnOff")}</Button>
      </>
    );
  } else if (step === "qr") {
    content = (
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="text-body text-muted-foreground">{t("scanQr")}</p>
        {qrDataUrl ? (
          // The QR code needs a light background in both themes to scan.
          <img src={qrDataUrl} alt={t("qrAlt")} className="size-48 rounded-lg" />
        ) : (
          <Skeleton className="size-48" />
        )}
        {manualKey ? (
          <p className="text-body text-muted-foreground">
            {t("manualKey")} <code className="text-foreground">{manualKey}</code>
          </p>
        ) : null}
      </div>
    );
    footer = (
      <>
        <Button type="button" variant="outline" onClick={close}>{t("cancel")}</Button>
        <Button type="button" onClick={() => setStep("verify")}>{t("continue")}</Button>
      </>
    );
  } else if (step === "verify") {
    content = codeField(method);
    footer = (
      <>
        <Button type="button" variant="outline" disabled={busy} onClick={() => setStep(method === "totp" ? "qr" : "password")}>{t("back")}</Button>
        <Button type="submit" loading={busy} disabled={code.length !== 6}>{t("verify")}</Button>
      </>
    );
  } else {
    content = (
      <div className="flex flex-col gap-3">
        <Alert variant="warning">
          <AlertCircle aria-hidden="true" />
          <AlertDescription>{t("saveCodesHelp")}</AlertDescription>
        </Alert>
        <ul className="grid grid-cols-2 gap-2 rounded-lg bg-muted p-3 font-mono text-body" aria-label={t("recoveryCodes")}>
          {recoveryCodes.map((item) => <li key={item} className="break-all text-center">{item}</li>)}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void copyCodes()}>
            <Copy aria-hidden="true" />
            {t("copyCodes")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => downloadRecoveryCodes(recoveryCodes, t("codesFileIntro", { email: user.email }))}>
            <Download aria-hidden="true" />
            {t("downloadCodes")}
          </Button>
        </div>
      </div>
    );
    footer = <Button type="button" onClick={close}>{t("done")}</Button>;
  }

  // The title stays put through every step; the line under it says what this step is for.
  const description: AccountMessageKey = step === "codes"
    ? "recoveryCodesTitle"
    : mode === "codes"
      ? "newCodesHelp"
      : mode === "off"
        ? "turnOffHelp"
        : mode === "change"
          ? (method === "totp" ? "useAuthenticatorHelp" : "useEmailCodesHelp")
          : "twoStepHelp";
  const submits = step === "password" || step === "verify" || step === "off";

  return (
    <Card id="two-step" className="scroll-mt-4">
      <UnsavedChangesGuard isDirty={dirty && step !== "codes"} isSubmitting={busy} />
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{t("twoStep")}</CardTitle>
          {mode === null && isEnabled ? <Badge variant="success">{t("on")}</Badge> : null}
        </div>
        <CardDescription>{t(description)}</CardDescription>
      </CardHeader>
      <form
        method="post"
        action="/admin/account"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!submits || busy) return;
          void (step === "password" ? confirmPassword() : step === "off" ? turnOff() : verify());
        }}
      >
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertDescription>{t(error)}</AlertDescription>
            </Alert>
          ) : null}
          {content}
        </CardContent>
        {footer ? <CardFooter className="justify-end gap-2">{footer}</CardFooter> : null}
      </form>
    </Card>
  );
}

/** A refused code in the words of the method it came from. */
function codeFailure(method: Method) {
  return ({ code, status }: AuthFailure): AccountMessageKey | null => {
    if (code === "TWO_FACTOR_SETUP_EXPIRED") return "setupExpired";
    if (code === "TWO_FACTOR_CODE_EXPIRED" || code === "OTP_HAS_EXPIRED") return "codeExpired";
    return status === 400 || status === 401 ? (method === "totp" ? "wrongAppCode" : "wrongEmailCode") : null;
  };
}
