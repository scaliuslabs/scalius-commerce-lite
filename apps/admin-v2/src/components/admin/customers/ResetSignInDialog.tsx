// Resetting how a customer signs in: for a buyer who lost every way in.
// Staff name one recovery contact (a phone or an email); the dialog says
// what the reset does before it runs. The API refuses a contact that signs
// in to, or recovers, another account; that refusal shows on the field.
import { useState } from "react";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { postApiV1AdminCustomersByIdResetSignIn } from "@scalius/api-client/sdk";
import { Alert, AlertDescription } from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { ChoiceField, Field, FieldSet } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { AdminPhoneInput, normalizeAdminPhone } from "~/components/admin/shared/AdminPhoneInput";
import { useMessages } from "~/i18n";
import { customerPageMessages } from "~/i18n/customer-page";
import { formMessages } from "~/i18n/forms";
import { resourceMessages } from "~/i18n/resource";
import { apiData, type ApiBody } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import { isCustomerSignInChanged, readCustomerSignInRefusal } from "~/lib/admin-api-conflicts";
import { toE164Phone } from "~/lib/admin-phone-schema";
import { queryKeys } from "~/lib/query-keys";
import { toast } from "~/lib/toast";
import { useCommand } from "~/lib/use-command";

/**
 * How long the recovery contact reaches the account: the API's
 * `SIGN_IN_RECOVERY_DAYS` (core `sign-in-writes.ts`; the test pins them equal).
 * The dialog says it before the reset runs, so it can't come from the answer.
 */
export const SIGN_IN_RECOVERY_DAYS = 7;

type ContactKind = "phone" | "email";
type ResetBody = ApiBody<typeof postApiV1AdminCustomersByIdResetSignIn>;

/** The request body for a typed contact, or which problem stops it. */
export function recoveryContactBody(kind: ContactKind, phone: string, email: string): ResetBody | "phoneInvalid" | "emailInvalid" {
  if (kind === "phone") {
    const e164 = toE164Phone(phone);
    return e164 ? { phone: e164 } : "phoneInvalid";
  }
  const trimmed = email.trim();
  return z.email().safeParse(trimmed).success ? { email: trimmed } : "emailInvalid";
}

interface ResetSignInDialogProps {
  customerId: string;
  /** The customer as every screen titles it. */
  name: string;
  /** The saved contacts, to prefill the recovery contact. */
  phone: string | null;
  email: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After the reset: the contact it saved (the page shows it as saved, not as an edit). */
  onReset?: (contact: ResetBody) => void;
}

export function ResetSignInDialog({ customerId, name, phone, email, open, onOpenChange, onReset }: ResetSignInDialogProps) {
  const t = useMessages(customerPageMessages);
  const queryClient = useQueryClient();
  const reset = useCommand({
    mutationFn: (body: ResetBody) => apiData(postApiV1AdminCustomersByIdResetSignIn({ path: { id: customerId }, body })),
    onSuccess: async (_result, contact) => {
      toast.success(t("signInResetToast"));
      onReset?.(contact);
      onOpenChange(false);
      // The customer (its contacts, how it signs in) and its change log.
      await queryClient.invalidateQueries({ queryKey: queryKeys.customers.all });
    },
  });
  const changeOpen = (next: boolean) => {
    if (reset.isPending) return;
    // Each opening starts from the saved contacts, without the last refusal.
    if (!next) reset.reset();
    onOpenChange(next);
  };
  return (
    <AlertDialog open={open} onOpenChange={changeOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("resetSignInTitle", { name })}</AlertDialogTitle>
          <AlertDialogDescription>{t("resetSignInBody", { days: SIGN_IN_RECOVERY_DAYS })}</AlertDialogDescription>
        </AlertDialogHeader>
        {/* Mounted with each opening (the content unmounts when closed), so the draft starts from the saved contacts. */}
        <RecoveryContactForm
          savedPhone={phone}
          savedEmail={email}
          pending={reset.isPending}
          error={reset.error}
          onEdit={() => {
            if (reset.isError) reset.reset();
          }}
          onSubmit={(body) => reset.mutate(body)}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RecoveryContactForm({ savedPhone, savedEmail, pending, error, onEdit, onSubmit }: {
  savedPhone: string | null;
  savedEmail: string | null;
  pending: boolean;
  error: Error | null;
  onEdit: () => void;
  onSubmit: (body: ResetBody) => void;
}) {
  const t = useMessages(customerPageMessages);
  const tf = useMessages(formMessages);
  const tr = useMessages(resourceMessages);
  const [kind, setKind] = useState<ContactKind>(savedPhone || !savedEmail ? "phone" : "email");
  const [phone, setPhone] = useState(normalizeAdminPhone(savedPhone ?? ""));
  const [email, setEmail] = useState(savedEmail ?? "");
  const [problem, setProblem] = useState<"phoneInvalid" | "emailInvalid" | null>(null);
  const refusal = readCustomerSignInRefusal(error);
  const taken = refusal?.reason === "recovery_contact_taken" && refusal.field === kind;
  const fieldError = problem
    ? tf(problem)
    : taken
      ? t(kind === "phone" ? "recoveryTakenPhone" : "recoveryTakenEmail")
      : undefined;
  const edited = () => {
    setProblem(null);
    onEdit();
  };
  const submit = () => {
    const body = recoveryContactBody(kind, phone, email);
    if (typeof body === "string") {
      setProblem(body);
      return;
    }
    onSubmit(body);
  };
  return (
    <>
      <div className="flex flex-col gap-4">
        <FieldSet label={t("recoveryContact")}>
          <RadioGroup
            value={kind}
            disabled={pending}
            onValueChange={(value) => {
              setKind(value as ContactKind);
              edited();
            }}
          >
            <ChoiceField id="reset-sign-in-phone" label={t("phone")} control={<RadioGroupItem id="reset-sign-in-phone" value="phone" />} />
            <ChoiceField id="reset-sign-in-email" label={t("email")} control={<RadioGroupItem id="reset-sign-in-email" value="email" />} />
          </RadioGroup>
        </FieldSet>
        {kind === "phone" ? (
          <Field label={t("phone")} error={fieldError}>
            <AdminPhoneInput
              value={phone}
              disabled={pending}
              onChange={(value) => {
                setPhone(value);
                edited();
              }}
            />
          </Field>
        ) : (
          <Field label={t("email")} error={fieldError}>
            <Input
              type="email"
              autoComplete="off"
              value={email}
              disabled={pending}
              onChange={(event) => {
                setEmail(event.target.value);
                edited();
              }}
            />
          </Field>
        )}
        {error && !taken ? (
          <Alert variant="destructive">
            <AlertDescription>{isCustomerSignInChanged(error) ? t("signInChanged") : getServerFnError(error, t("resetSignInFailed"))}</AlertDescription>
          </Alert>
        ) : null}
      </div>
      <AlertDialogFooter>
        <AlertDialogCancel disabled={pending}>{tr("cancel")}</AlertDialogCancel>
        <Button type="button" variant="destructive" loading={pending} onClick={submit}>
          {pending ? t("resettingSignIn") : t("resetSignIn")}
        </Button>
      </AlertDialogFooter>
    </>
  );
}
