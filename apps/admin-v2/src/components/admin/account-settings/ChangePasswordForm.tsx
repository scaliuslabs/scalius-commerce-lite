import { useState, type SyntheticEvent } from "react";
import { AlertCircle, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { postApiV1AdminAuthChangePassword } from "@scalius/api-client/sdk";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { useHydrated } from "~/hooks/use-hydrated";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { apiData } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import { useMessages } from "~/i18n";
import { accountMessages } from "~/i18n/account";

const MIN_LENGTH = 12;
type Field = "current" | "next" | "confirm";

/**
 * Password card. The form is POST-only with no `name` attributes and stays
 * disabled until hydration, so no password can ever reach a URL or the server
 * without the API call.
 */
export function ChangePasswordForm() {
  const t = useMessages(accountMessages);
  const isHydrated = useHydrated();
  const [values, setValues] = useState<Record<Field, string>>({ current: "", next: "", confirm: "" });
  const [touched, setTouched] = useState<Partial<Record<Field, boolean>>>({});
  const [shown, setShown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [wrongCurrent, setWrongCurrent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const errors: Partial<Record<Field, string>> = {
    current: wrongCurrent ? t("wrongCurrentPassword") : touched.current && !values.current ? t("enterCurrentPassword") : undefined,
    next: touched.next && values.next.length < MIN_LENGTH ? t("passwordTooShort") : undefined,
    confirm: touched.confirm && values.confirm !== values.next ? t("passwordsDontMatch") : undefined,
  };

  const set = (field: Field, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    if (field === "current") setWrongCurrent(false);
  };

  const handleSubmit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setTouched({ current: true, next: true, confirm: true });
    setError(null);
    if (!values.current || values.next.length < MIN_LENGTH || values.next !== values.confirm) return;
    setSaving(true);
    try {
      await apiData(postApiV1AdminAuthChangePassword({ body: { currentPassword: values.current, newPassword: values.next } }));
      setValues({ current: "", next: "", confirm: "" });
      setTouched({});
      setShown(false);
      toast.success(t("passwordChanged"));
    } catch (err) {
      if (err instanceof AdminApiResponseError && err.status === 400 && /current password/i.test(err.message)) setWrongCurrent(true);
      else setError(getServerFnError(err, t("passwordFailed")));
    } finally {
      setSaving(false);
    }
  };

  const field = (id: Field, label: string, autoComplete: string, help?: string) => {
    const describedBy = errors[id] ? `password-${id}-error` : help ? `password-${id}-help` : undefined;
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`password-${id}`}>{label}</Label>
        <Input
          id={`password-${id}`}
          type={shown ? "text" : "password"}
          value={values[id]}
          autoComplete={autoComplete}
          required
          disabled={!isHydrated || saving}
          aria-invalid={errors[id] ? true : undefined}
          aria-describedby={describedBy}
          onBlur={() => setTouched((current) => ({ ...current, [id]: Boolean(values[id]) || current[id] }))}
          onChange={(event) => set(id, event.target.value)}
        />
        {errors[id] ? (
          <p id={`password-${id}-error`} className="text-body text-destructive">{errors[id]}</p>
        ) : help ? (
          <p id={`password-${id}-help`} className="text-body text-muted-foreground">{help}</p>
        ) : null}
      </div>
    );
  };

  return (
    <Card>
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
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {field("current", t("currentPassword"), "current-password")}
          {field("next", t("newPassword"), "new-password", t("passwordMinHelp"))}
          {field("confirm", t("confirmPassword"), "new-password")}
          <div>
            <Button type="button" variant="link" size="sm" className="-ml-3 sm:-ml-2.5" disabled={!isHydrated || saving} aria-pressed={shown} onClick={() => setShown((value) => !value)}>
              {shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              {t(shown ? "hidePasswords" : "showPasswords")}
            </Button>
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" loading={saving} disabled={!isHydrated || !values.current || !values.next || !values.confirm}>
            {t("changePassword")}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
