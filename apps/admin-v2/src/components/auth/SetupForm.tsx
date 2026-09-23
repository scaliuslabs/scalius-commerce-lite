import { useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { postApiV1Setup } from "@scalius/api-client/sdk";
import { ADMIN_SETUP_TOKEN_HEADER } from "@scalius/shared/setup-token";
import { authClient } from "@/lib/auth-client";
import { apiData } from "@/lib/api";
import { storePendingTwoFactorMethods } from "@/lib/two-factor-pending";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMessages } from "~/i18n";
import { authMessages, type AuthMessageKey } from "~/i18n/auth";
import { authFailureMessage, emailError, newPasswordError, type AuthMessage } from "./auth-error";
import { AuthAlert, AuthHeader, Field, PasswordInput, describedBy, linkClassName } from "./auth-ui";

type FieldName = "name" | "email" | "password" | "confirmPassword" | "setupKey";

/** The first administrator of a new store. Optionally gated by a setup key from the operator. */
export function SetupForm({ setupTokenRequired = false }: { setupTokenRequired?: boolean }) {
  const t = useMessages(authMessages);
  const navigate = useNavigate();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState<Record<FieldName, string>>({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    setupKey: "",
  });
  const [errors, setErrors] = useState<Partial<Record<FieldName, AuthMessageKey | null>>>({});
  const [failure, setFailure] = useState<AuthMessage | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  function focusField(name: FieldName) {
    formRef.current?.querySelector<HTMLInputElement>(`#setup-${name}`)?.focus();
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isLoading) return;
    const next: Partial<Record<FieldName, AuthMessageKey | null>> = {
      name: values.name.trim() ? null : "nameRequired",
      email: emailError(values.email),
      password: newPasswordError(values.password),
      confirmPassword: values.confirmPassword === values.password ? null : "passwordsDontMatch",
      setupKey: setupTokenRequired && !values.setupKey.trim() ? "setupKeyRequired" : null,
    };
    setErrors(next);
    setFailure(null);
    const firstInvalid = (Object.keys(next) as FieldName[]).find((name) => next[name]);
    if (firstInvalid) return focusField(firstInvalid);

    setIsLoading(true);
    const email = values.email.trim();
    try {
      // The setup key travels as a header, never in the body or the URL.
      await apiData(
        postApiV1Setup({
          body: { name: values.name.trim(), email, password: values.password },
          headers: setupTokenRequired ? { [ADMIN_SETUP_TOKEN_HEADER]: values.setupKey.trim() } : undefined,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/setup token/i.test(message)) {
        setErrors({ setupKey: "setupKeyInvalid" });
        focusField("setupKey");
      } else {
        setFailure(
          authFailureMessage(error, ({ status }) =>
            status === 403 ? "adminExists" : status === 409 ? "setupBusy" : null,
          ),
        );
      }
      setIsLoading(false);
      return;
    }

    // The account exists now; if signing in fails, the sign-in page takes over.
    try {
      const { data, error } = await authClient.signIn.email({ email, password: values.password });
      const result = data as { twoFactorRedirect?: boolean; twoFactorMethods?: readonly unknown[] } | null;
      if (!error && result?.twoFactorRedirect) {
        storePendingTwoFactorMethods(result.twoFactorMethods);
        await navigate({ to: "/auth/two-factor" });
        return;
      }
      await navigate({ to: error ? "/auth/login" : "/admin" });
    } catch {
      await navigate({ to: "/auth/login" });
    }
  }

  function field(name: FieldName) {
    const message = errors[name] ? t(errors[name]) : null;
    return {
      message,
      input: {
        id: `setup-${name}`,
        value: values[name],
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
          const value = event.target.value;
          setValues((current) => ({ ...current, [name]: value }));
          if (errors[name]) setErrors((current) => ({ ...current, [name]: null }));
        },
        ...describedBy(`setup-${name}`, message, name === "password" ? t("passwordHint") : name === "setupKey" ? t("setupKeyHint") : undefined),
      },
    };
  }

  const name = field("name");
  const email = field("email");
  const password = field("password");
  const confirm = field("confirmPassword");
  const setupKey = field("setupKey");

  return (
    <div className="flex flex-col gap-6">
      <AuthHeader title={t("setupTitle")} description={t("setupDescription")} />
      <form ref={formRef} method="post" action="/auth/setup" onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <AuthAlert message={failure}>
          {failure?.key === "adminExists" ? (
            <Link to="/auth/login" className={linkClassName}>
              {t("signIn")}
            </Link>
          ) : null}
        </AuthAlert>
        <Field id="setup-name" label={t("name")} error={name.message}>
          <Input {...name.input} autoComplete="name" autoFocus />
        </Field>
        <Field id="setup-email" label={t("email")} error={email.message}>
          <Input {...email.input} type="email" inputMode="email" autoComplete="username" autoCapitalize="none" spellCheck={false} />
        </Field>
        <Field id="setup-password" label={t("password")} error={password.message} hint={t("passwordHint")}>
          <PasswordInput {...password.input} autoComplete="new-password" />
        </Field>
        <Field id="setup-confirmPassword" label={t("confirmPassword")} error={confirm.message}>
          <PasswordInput {...confirm.input} autoComplete="new-password" />
        </Field>
        {setupTokenRequired ? (
          <Field id="setup-setupKey" label={t("setupKey")} error={setupKey.message} hint={t("setupKeyHint")}>
            <PasswordInput {...setupKey.input} autoComplete="off" />
          </Field>
        ) : null}
        <Button type="submit" className="w-full" loading={isLoading}>
          {t("createAccount")}
        </Button>
      </form>
    </div>
  );
}
