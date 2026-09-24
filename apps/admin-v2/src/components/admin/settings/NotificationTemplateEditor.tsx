import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Braces } from "lucide-react";
import { toast } from "sonner";
import { getApiV1AdminSettingsBusiness } from "@scalius/api-client/sdk";
import type { OrderNotificationType } from "@scalius/core/modules/notifications/notification-types";
import {
  DEFAULT_NOTIFICATION_TEMPLATES,
  TEMPLATE_LIMITS,
  findUnknownVariables,
  renderTemplate,
  sampleOrderEmail,
  sampleVariables,
  variablesForEvent,
  type EmailTemplate,
  type NotificationTemplates,
} from "@scalius/core/modules/notifications/notification-templates";
import { normalizeBdMobile } from "@scalius/shared/phone-input";
import { countSmsSegments } from "@scalius/shared/sms-segments";
import { AdminPhoneInput } from "~/components/admin/shared/AdminPhoneInput";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiClient, apiData } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import {
  notificationEventMessages,
  notificationTemplateMessages,
  notificationsMessages,
} from "~/i18n/settings-notifications";
import { customerRulesQuery } from "./NotificationSettings";
import { SettingsCard, SettingsCardLoading, SettingsField } from "./SettingsPage";
import { SettingsLoadFailure } from "./SettingsLoadFailure";

interface TemplatesData {
  templates: NotificationTemplates;
  revision: number;
}

// Stopgap until `pnpm generate:sdk` adds the notification template operations.
const TEMPLATES_URL = "/api/v1/admin/settings/notification-channels/templates";
const JSON_HEADERS = { "Content-Type": "application/json" };

export const templatesQuery = {
  queryKey: [...queryKeys.settings.notificationChannels(), "templates"] as const,
  queryFn: async () => (await apiData(apiClient.get({ url: TEMPLATES_URL }))) as TemplatesData,
};

const sendTest = (body: Record<string, string>) =>
  apiData(apiClient.post({ url: `${TEMPLATES_URL}/test`, headers: JSON_HEADERS, body }));

type Problem =
  | { key: "required" }
  | { key: "tooLong"; max: number }
  | { key: "unknownVariables"; names: string };

/** What's wrong with one template field, as the server would say it. */
export function templateProblem(text: string, max: number, event: OrderNotificationType): Problem | null {
  if (!text.trim()) return { key: "required" };
  if (text.length > max) return { key: "tooLong", max };
  const unknown = findUnknownVariables(text, event);
  return unknown.length > 0 ? { key: "unknownVariables", names: unknown.map((name) => `{{${name}}}`).join(", ") } : null;
}

/** Puts `token` at the caret of the field with `id` and keeps typing there. */
function insertAtCaret(id: string, current: string, token: string, apply: (next: string) => void) {
  const field = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  const start = field?.selectionStart ?? current.length;
  const end = field?.selectionEnd ?? current.length;
  apply(current.slice(0, start) + token + current.slice(end));
  requestAnimationFrame(() => {
    field?.focus();
    field?.setSelectionRange(start + token.length, start + token.length);
  });
}

function VariableMenu({
  event,
  disabled,
  onInsert,
}: {
  event: OrderNotificationType;
  disabled: boolean;
  onInsert: (token: string) => void;
}) {
  const t = useMessages(notificationTemplateMessages);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          <Braces aria-hidden="true" />
          {t("insertVariable")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {variablesForEvent(event).map((variable) => (
          <DropdownMenuItem key={variable} onSelect={() => onInsert(`{{${variable}}}`)}>
            <span className="flex-1">{t(variable)}</span>
            <code className="text-muted-foreground">{`{{${variable}}}`}</code>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Characters and SMS parts of what the customer receives (the sample render). */
export function SmsCounter({ text }: { text: string }) {
  const t = useMessages(notificationTemplateMessages);
  const count = countSmsSegments(text);
  return (
    <p aria-live="polite" className="text-body tabular-nums text-muted-foreground">
      {t("smsCount", { characters: count.characters, segments: count.segments, encoding: t(count.encoding) })}
    </p>
  );
}

function TestSmsDialog({
  open,
  onOpenChange,
  event,
  body,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  event: OrderNotificationType;
  body: string;
}) {
  const t = useMessages(notificationTemplateMessages);
  const [phone, setPhone] = useState("");
  const [left, setLeft] = useState(false);
  const [sending, setSending] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const invalid = !normalizeBdMobile(phone);
  const error = serverError ?? (invalid && left ? t("testPhoneInvalid") : null);

  async function send() {
    if (invalid) {
      setLeft(true);
      return;
    }
    setSending(true);
    setServerError(null);
    try {
      await sendTest({ channel: "sms", event, body, phone });
      toast.success(t("testSent"));
      onOpenChange(false);
    } catch (cause) {
      setServerError(getServerFnError(cause));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("testSmsTitle")}</DialogTitle>
          <DialogDescription>{t("testSmsHelp")}</DialogDescription>
        </DialogHeader>
        <form
          method="post"
          className="space-y-4"
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault();
            void send();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="test-sms-phone">{t("testPhone")}</Label>
            <AdminPhoneInput
              id="test-sms-phone"
              value={phone}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "test-sms-phone-note" : undefined}
              onChange={(value) => {
                setPhone(value);
                setServerError(null);
              }}
              onBlur={() => setLeft(true)}
            />
            {error ? <p id="test-sms-phone-note" role="alert" className="text-body text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
            <Button type="submit" loading={sending}>{t("send")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Shopify-style editor for one customer message: email and SMS copy, variables, live preview, test sends. */
export function NotificationTemplateEditor({ event }: { event: OrderNotificationType }) {
  const t = useMessages(notificationTemplateMessages);
  const channels = useMessages(notificationsMessages);
  const events = useMessages(notificationEventMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_NOTIFICATIONS_EDIT);
  const [emailField, setEmailField] = useState<"subject" | "body">("body");
  const [smsTestOpen, setSmsTestOpen] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const rules = useQuery(customerRulesQuery);
  const business = useQuery({
    queryKey: queryKeys.settings.business(),
    queryFn: () => apiData(getApiV1AdminSettingsBusiness()),
  });
  const { values, setValues, isLoadError, refetch } = useSettingsForm<{ templates: NotificationTemplates }>({
    label: events(event),
    queryKey: templatesQuery.queryKey,
    fetchFn: templatesQuery.queryFn,
    saveFn: (draft, expectedRevision) =>
      apiData(apiClient.put({
        url: TEMPLATES_URL,
        headers: JSON_HEADERS,
        body: {
          event,
          email: draft.templates.email[event],
          sms: draft.templates.sms[event],
          expectedRevision,
        },
      })),
    defaultValues: {} as { templates: NotificationTemplates },
    errorMessage: common("saveFailed"),
    canEdit,
    isValid: (draft) =>
      Boolean(draft.templates)
      && !templateProblem(draft.templates.email[event].subject, TEMPLATE_LIMITS.subject, event)
      && !templateProblem(draft.templates.email[event].body, TEMPLATE_LIMITS.emailBody, event)
      && !templateProblem(draft.templates.sms[event].body, TEMPLATE_LIMITS.smsBody, event),
    fields: { "email.subject": "template-email-subject", "email.body": "template-email-body", "sms.body": "template-sms-body" },
  });

  if (isLoadError) return <SettingsLoadFailure title={events(event)} onRetry={refetch} />;
  if (!values.templates) return <SettingsCardLoading />;

  const email = values.templates.email[event];
  const sms = values.templates.sms[event];
  const defaults = { email: DEFAULT_NOTIFICATION_TEMPLATES.email[event], sms: DEFAULT_NOTIFICATION_TEMPLATES.sms[event] };
  const storeName = business.data?.companyName?.trim() || business.data?.legalName?.trim() || "";
  const sample = sampleVariables(storeName);
  const emailPreview = sampleOrderEmail({
    storeName,
    subject: renderTemplate(email.subject, sample),
    body: renderTemplate(email.body, sample),
  });
  const smsPreview = renderTemplate(sms.body, sample);
  const saved = rules.data?.channels[event];
  const describe = (problem: Problem | null) =>
    !problem ? null
      : problem.key === "tooLong" ? t("tooLong", { max: problem.max })
      : problem.key === "unknownVariables" ? t("unknownVariables", { names: problem.names })
      : t("required");

  const setEmail = (patch: Partial<EmailTemplate>) =>
    setValues((draft) => ({
      templates: {
        ...draft.templates,
        email: { ...draft.templates.email, [event]: { ...draft.templates.email[event], ...patch } },
      },
    }));
  const setSmsBody = (body: string) =>
    setValues((draft) => ({
      templates: { ...draft.templates, sms: { ...draft.templates.sms, [event]: { body } } },
    }));

  async function sendTestEmail() {
    setSendingEmail(true);
    try {
      await sendTest({ channel: "email", event, subject: email.subject, body: email.body });
      toast.success(t("testSent"));
    } catch (cause) {
      toast.error(getServerFnError(cause));
    } finally {
      setSendingEmail(false);
    }
  }

  return (
    <>
      <SettingsCard
        title={channels("email")}
        action={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!canEdit || (email.subject === defaults.email.subject && email.body === defaults.email.body)}
            onClick={() => setEmail(defaults.email)}
          >
            {t("resetDefault")}
          </Button>
        }
      >
        {saved && !saved.includes("email") ? (
          <p className="text-body text-muted-foreground">{t("channelOff", { channel: channels("email") })}</p>
        ) : null}
        <SettingsField
          id="template-email-subject"
          label={t("subject")}
          error={describe(templateProblem(email.subject, TEMPLATE_LIMITS.subject, event))}
        >
          <Input
            id="template-email-subject"
            value={email.subject}
            disabled={!canEdit}
            onFocus={() => setEmailField("subject")}
            onChange={(change) => setEmail({ subject: change.target.value })}
          />
        </SettingsField>
        <SettingsField
          id="template-email-body"
          label={t("message")}
          help={t("emailHelp")}
          error={describe(templateProblem(email.body, TEMPLATE_LIMITS.emailBody, event))}
        >
          <Textarea
            id="template-email-body"
            rows={8}
            value={email.body}
            disabled={!canEdit}
            aria-describedby="template-email-body-note"
            onFocus={() => setEmailField("body")}
            onChange={(change) => setEmail({ body: change.target.value })}
          />
        </SettingsField>
        <div className="flex flex-wrap items-center gap-2">
          <VariableMenu
            event={event}
            disabled={!canEdit}
            onInsert={(token) =>
              insertAtCaret(`template-email-${emailField}`, email[emailField], token, (next) => setEmail({ [emailField]: next }))}
          />
          <Button type="button" variant="outline" size="sm" loading={sendingEmail} disabled={!canEdit} onClick={() => void sendTestEmail()}>
            {t("sendTestEmail")}
          </Button>
        </div>
        <p className="text-body text-muted-foreground">{t("testEmailTo")}</p>
        <div className="space-y-1.5">
          <p className="text-body font-medium">{t("preview")}</p>
          <p className="text-body text-muted-foreground">{t("previewNote")}</p>
          {/* A sandboxed document: the real email markup, no scripts, no navigation. */}
          <iframe
            title={t("emailPreview")}
            sandbox=""
            srcDoc={emailPreview.html}
            className="h-96 w-full rounded-lg border border-border bg-card"
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title={channels("sms")}
        action={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!canEdit || sms.body === defaults.sms.body}
            onClick={() => setSmsBody(defaults.sms.body)}
          >
            {t("resetDefault")}
          </Button>
        }
      >
        {saved && !saved.includes("sms") ? (
          <p className="text-body text-muted-foreground">{t("channelOff", { channel: channels("sms") })}</p>
        ) : null}
        <SettingsField
          id="template-sms-body"
          label={t("message")}
          help={t("lineRule")}
          error={describe(templateProblem(sms.body, TEMPLATE_LIMITS.smsBody, event))}
        >
          <Textarea
            id="template-sms-body"
            rows={4}
            value={sms.body}
            disabled={!canEdit}
            aria-describedby="template-sms-body-note"
            onChange={(change) => setSmsBody(change.target.value)}
          />
        </SettingsField>
        <div className="flex flex-wrap items-center gap-2">
          <VariableMenu
            event={event}
            disabled={!canEdit}
            onInsert={(token) => insertAtCaret("template-sms-body", sms.body, token, setSmsBody)}
          />
          <Button type="button" variant="outline" size="sm" disabled={!canEdit} onClick={() => setSmsTestOpen(true)}>
            {t("sendTestSms")}
          </Button>
        </div>
        <div className="space-y-1.5">
          <p className="text-body font-medium">{t("preview")}</p>
          <p data-testid="sms-preview" className="whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-body">{smsPreview}</p>
          <SmsCounter text={smsPreview} />
          <p className="text-body text-muted-foreground">{t("smsCountNote")}</p>
        </div>
        <TestSmsDialog open={smsTestOpen} onOpenChange={setSmsTestOpen} event={event} body={sms.body} />
      </SettingsCard>

      <SettingsCard title={channels("whatsapp")}>
        <p className="text-body text-muted-foreground">
          {t("whatsappInfo", { template: rules.data?.whatsappTemplate.templateName ?? "order_status_update" })}
        </p>
      </SettingsCard>
    </>
  );
}
