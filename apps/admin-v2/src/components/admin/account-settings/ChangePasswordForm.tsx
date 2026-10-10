import { useState, type SyntheticEvent } from "react";
import { AlertCircle, Eye, EyeOff } from "lucide-react";
import { toast } from "~/lib/toast";
import { postApiV1AdminAuthChangePassword } from "@scalius/api-client/sdk";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Field } from "~/components/ui/field";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { useHydrated } from "~/hooks/use-hydrated";
import { apiData } from "~/lib/api";
import { useMessages } from "~/i18n";
import { accountMessages, type AccountMessageKey } from "~/i18n/account";
import { accountFailureKey } from "./account-error";

const MIN_LENGTH = 12;
type PasswordKey = "current" | "next" | "confirm";

/**
 * Password card. The form is POST-only with no `name` attributes and stays
 * disabled until hydration, so no password can ever reach a URL or the server
 * without the API call.
 */
export function ChangePasswordForm() {
  const t = useMessages(accountMessages);
  const isHydrated = useHydrated();
  const [values, setValues] = useState<Record<PasswordKey, string>>({ current: "", next: "", confirm: "" });
  const [touched, setTouched] = useState<Partial<Record<PasswordKey, boolean>>>({});
  const [shown, setShown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [wrongCurrent, setWrongCurrent] = useState(false);
  const [error, setError] = useState<AccountMessageKey | null>(null);

  const reused = values.next.length > 0 && values.next === values.current;
  const errors: Partial<Record<PasswordKey, string>> = {
    current: wrongCurrent ? t("wrongCurrentPassword") : touched.current && !values.current ? t("enterCurrentPassword") : undefined,
    next: touched.next && values.next.length < MIN_LENGTH
      ? t("passwordTooShort")
      : touched.next && reused ? t("passwordReused") : undefined,
    confirm: touched.confirm && values.confirm !== values.next ? t("passwordsDontMatch") : undefined,
  };

  const set = (field: PasswordKey, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    if (field === "current") setWrongCurrent(false);
  };

  const handleSubmit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setTouched({ current: true, next: true, confirm: true });
    setError(null);
    if (!values.current || values.next.length < MIN_LENGTH || reused || values.next !== values.confirm) return;
    setSaving(true);
    try {
      await apiData(postApiV1AdminAuthChangePassword({ body: { currentPassword: values.current, newPassword: values.next } }));
      setValues({ current: "", next: "", confirm: "" });
      setTouched({});
      setShown(false);
      toast.success(t("passwordChanged"));
    } catch (err) {
      const key = accountFailureKey(err, ({ code }) =>
        code === "PASSWORD_INCORRECT" ? "wrongCurrentPassword" : code === "PASSWORD_REUSED" ? "passwordReused" : null);
      if (key === "wrongCurrentPassword") setWrongCurrent(true);
      else setError(key);
    } finally {
      setSaving(false);
    }
  };

  const field = (id: PasswordKey, label: string, autoComplete: string, help?: string) => {
    return (
      <Field id={`password-${id}`} label={label} help={help} error={errors[id]}>
        <Input
          type={shown ? "text" : "password"}
          value={values[id]}
          autoComplete={autoComplete}
          required
          disabled={!isHydrated || saving}
          onBlur={() => setTouched((current) => ({ ...current, [id]: Boolean(values[id]) || current[id] }))}
          onChange={(event) => set(id, event.target.value)}
        />
      </Field>
    );
  };

  return (
    <Card id="password" className="scroll-mt-4">
      <UnsavedChangesGuard
        isDirty={Boolean(values.current || values.next || values.confirm)}
        isSubmitting={saving}
      />
      <CardHeader>
        <CardTitle>{t("password")}</CardTitle>
        <CardDescription>{t("passwordHelp")}</CardDescription>
      </CardHeader>
      <form method="post" action="/admin/account" onSubmit={handleSubmit} noValidate>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden="true" />
              <AlertDescription>{t(error)}</AlertDescription>
            </Alert>
          ) : null}
          {field("current", t("currentPassword"), "current-password")}
          {field("next", t("newPassword"), "new-password", t("passwordMinHelp"))}
          {field("confirm", t("confirmPassword"), "new-password")}
          <div>
            <Button type="button" variant="link" size="sm" className="-ms-3 sm:-ms-2.5" disabled={!isHydrated || saving} aria-pressed={shown} onClick={() => setShown((value) => !value)}>
              {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              {t(shown ? "hidePasswords" : "showPasswords")}
            </Button>
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          {/* Secondary: the page's one primary is "Turn on" two-step verification (C3); Save shows what is missing (C5). */}
          <Button type="submit" variant="outline" loading={saving} disabled={!isHydrated}>
            {t("changePassword")}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
