// Create or edit one webhook in a dialog with its own save scope, as
// `SettingsDialog` does, but opened from the list's menu. An edit is guarded by
// the version it opened with: a stale save offers "Reload and keep my edits".
// A new subscription's signing secret goes straight to `onCreated` (component
// state), never into a query or mutation cache. Buyer contact data is off
// until a category is ticked (COMMERCE-HOOKS H5): deliveries read it as null.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { OUTBOUND_URL_MAX_LENGTH, checkOutboundUrl } from "@scalius/shared/outbound-url";
import { PROTECTED_CUSTOMER_DATA, type ProtectedCustomerData } from "@scalius/shared/plugins/protected-data";
import { Checkbox } from "~/components/ui/checkbox";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import {
  SaveConflict,
  SaveErrorBanner,
  SaveScope,
  useSaveBar,
  useServerFieldError,
  useSaveScope,
  type SaveScopeState,
} from "~/components/admin/shared/SaveBar";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { useMessages } from "~/i18n";
import { saveBarMessages } from "~/i18n/save-bar";
import { URL_ISSUE_MESSAGE, webhooksMessages } from "~/i18n/settings-webhooks";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { queryKeys } from "~/lib/query-keys";
import {
  createWebhook,
  getWebhook,
  updateWebhook,
  type WebhookInput,
  type WebhookSubscription,
} from "~/lib/api-query-options/webhooks";
import { SettingsField } from "../SettingsPage";
import { WebhookTopicPicker, normalizeTopics } from "./WebhookTopicPicker";

export const WEBHOOK_DESCRIPTION_MAX = 200;

const FIELD_IDS = { url: "webhook-url", topics: "webhook-topics", description: "webhook-description", customerData: "webhook-customer-data" } as const;

interface Draft {
  url: string;
  topics: Set<string>;
  description: string;
  customerData: Set<ProtectedCustomerData>;
}

function draftOf(subscription: WebhookSubscription | null): Draft {
  return {
    url: subscription?.url ?? "",
    topics: new Set(subscription?.topics ?? []),
    description: subscription?.description ?? "",
    customerData: new Set(subscription?.customerData ?? []),
  };
}

/** What the API would store for a draft. */
function inputOf(draft: Draft): WebhookInput & { customerData: ProtectedCustomerData[] } {
  const description = draft.description.trim();
  return {
    url: draft.url.trim(),
    topics: normalizeTopics(draft.topics),
    description: description || null,
    customerData: PROTECTED_CUSTOMER_DATA.filter((category) => draft.customerData.has(category)),
  };
}

const sameInput = (left: ReturnType<typeof inputOf>, right: ReturnType<typeof inputOf>) =>
  left.url === right.url &&
  left.description === right.description &&
  left.topics.join("\n") === right.topics.join("\n") &&
  left.customerData.join("\n") === right.customerData.join("\n");

const CUSTOMER_DATA_LABEL = {
  name: "customerDataName",
  email: "customerDataEmail",
  phone: "customerDataPhone",
  address: "customerDataAddress",
} as const satisfies Record<ProtectedCustomerData, string>;

function WebhookForm({
  subscription,
  topicFilters,
  onCreated,
}: {
  subscription: WebhookSubscription | null;
  topicFilters: readonly string[];
  onCreated: (secret: string) => void;
}) {
  const t = useMessages(webhooksMessages);
  const queryClient = useQueryClient();
  // The version this edit is based on; a conflict reload moves it forward.
  const [base, setBase] = useState(subscription);
  const [draft, setDraft] = useState(() => draftOf(subscription));
  const scope = useSaveScope();
  const topicsError = useServerFieldError(FIELD_IDS.topics);

  const input = inputOf(draft);
  const saved = base ? inputOf(draftOf(base)) : inputOf(draftOf(null));
  const dirty = !sameInput(input, saved);
  const urlCheck = checkOutboundUrl(input.url);
  const urlError = urlCheck.ok ? undefined : t(URL_ISSUE_MESSAGE[urlCheck.issue], { max: OUTBOUND_URL_MAX_LENGTH });
  const topicsMissing = input.topics.length === 0;
  const descriptionError = [...input.description ?? ""].length > WEBHOOK_DESCRIPTION_MAX
    ? t("noteTooLong", { max: WEBHOOK_DESCRIPTION_MAX })
    : undefined;
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.webhooks.all });

  useSaveBar({
    dirty,
    invalid: Boolean(urlError || topicsMissing || descriptionError),
    fields: FIELD_IDS,
    save: async () => {
      if (!base) {
        const result = await createWebhook(input);
        onCreated(result.secret);
        void refresh();
        return;
      }
      const changes: Partial<WebhookInput> = {};
      if (input.url !== saved.url) changes.url = input.url;
      if (input.topics.join("\n") !== saved.topics.join("\n")) changes.topics = input.topics;
      if (input.description !== saved.description) changes.description = input.description;
      if (input.customerData.join("\n") !== saved.customerData.join("\n")) changes.customerData = input.customerData;
      try {
        setBase(await updateWebhook(base.id, { ...changes, expectedVersion: base.version }));
      } catch (error) {
        if (isAdminApiConflictError(error)) throw new SaveConflict(t("conflict"));
        throw error;
      }
      void refresh();
    },
    discard: () => setDraft(draftOf(base)),
    // Someone else saved first: take their version and keep only what was edited here.
    reload: base
      ? async () => {
          const latest = await getWebhook(base.id);
          const before = draftOf(base);
          const theirs = draftOf(latest);
          setDraft((current) => ({
            url: current.url !== before.url ? current.url : theirs.url,
            topics: normalizeTopics(current.topics).join("\n") !== normalizeTopics(before.topics).join("\n") ? current.topics : theirs.topics,
            description: current.description !== before.description ? current.description : theirs.description,
            customerData: [...current.customerData].sort().join("\n") !== [...before.customerData].sort().join("\n") ? current.customerData : theirs.customerData,
          }));
          setBase(latest);
          void refresh();
        }
      : undefined,
  });

  const topicsShown = topicsError.error ?? (topicsMissing && scope?.revealed ? t("eventsRequired") : undefined);
  return (
    <>
      <SettingsField id={FIELD_IDS.url} label={t("url")} help={t("urlHelp")} error={urlError}>
        <Input
          id={FIELD_IDS.url}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={draft.url}
          placeholder={t("urlPlaceholder")}
          aria-describedby={`${FIELD_IDS.url}-note`}
          onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))}
        />
      </SettingsField>
      <fieldset className="space-y-1.5">
        <legend className="mb-1.5 text-body font-medium">{t("events")}</legend>
        <WebhookTopicPicker
          id={FIELD_IDS.topics}
          value={draft.topics}
          topicFilters={topicFilters}
          invalid={Boolean(topicsShown)}
          onChange={(topics) => {
            setDraft((current) => ({ ...current, topics }));
            if (topicsError.error) topicsError.clear();
          }}
        />
        {topicsShown ? (
          <p id={`${FIELD_IDS.topics}-note`} role="alert" className="text-body text-destructive">{topicsShown}</p>
        ) : (
          <p id={`${FIELD_IDS.topics}-note`} className="text-body text-muted-foreground">{t("eventsHelp")}</p>
        )}
      </fieldset>
      <SettingsField id={FIELD_IDS.description} label={t("note")} help={t("noteHelp")} error={descriptionError}>
        <Input
          id={FIELD_IDS.description}
          value={draft.description}
          maxLength={WEBHOOK_DESCRIPTION_MAX * 2}
          autoComplete="off"
          placeholder={t("notePlaceholder")}
          aria-describedby={`${FIELD_IDS.description}-note`}
          onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
        />
      </SettingsField>
      <fieldset id={FIELD_IDS.customerData} className="space-y-1.5" aria-describedby={`${FIELD_IDS.customerData}-note`}>
        <legend className="mb-1.5 text-body font-medium">{t("customerData")}</legend>
        <p id={`${FIELD_IDS.customerData}-note`} className="text-body text-muted-foreground">{t("customerDataHelp")}</p>
        {PROTECTED_CUSTOMER_DATA.map((category) => (
          <label key={category} className="flex min-h-9 items-start gap-3 py-1.5 text-body">
            <span className="flex h-lh items-center">
              <Checkbox
                checked={draft.customerData.has(category)}
                onCheckedChange={(value) => setDraft((current) => {
                  const next = new Set(current.customerData);
                  if (value === true) next.add(category);
                  else next.delete(category);
                  return { ...current, customerData: next };
                })}
              />
            </span>
            {t(CUSTOMER_DATA_LABEL[category])}
          </label>
        ))}
      </fieldset>
    </>
  );
}

/**
 * Cancel, Esc, ✕ or a click outside closes a clean dialog and asks before
 * discarding edits; a failed save keeps it open with the problems listed.
 */
export function WebhookFormDialog({
  open,
  onOpenChange,
  subscription,
  topicFilters,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null creates a webhook. */
  subscription: WebhookSubscription | null;
  topicFilters: readonly string[];
  onCreated: (secret: string) => void;
}) {
  const t = useMessages(webhooksMessages);
  const bar = useMessages(saveBarMessages);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const close = (state: SaveScopeState) => {
    state.discardAll();
    setConfirmDiscard(false);
    onOpenChange(false);
  };
  const requestClose = (state: SaveScopeState) => {
    if (state.busy) return;
    if (state.dirty) setConfirmDiscard(true);
    else close(state);
  };
  return (
    <SaveScope
      savedMessage={t(subscription ? "saved" : "created")}
      render={(state) => (
        <>
          <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose(state))}>
            <DialogContent className="sm:max-w-160">
              <DialogHeader>
                <DialogTitle>{t(subscription ? "editTitle" : "createTitle")}</DialogTitle>
                <DialogDescription>{t("formDescription")}</DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <SaveErrorBanner />
                <WebhookForm
                  key={subscription?.id ?? "new"}
                  subscription={subscription}
                  topicFilters={topicFilters}
                  onCreated={onCreated}
                />
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" disabled={state.busy} onClick={() => requestClose(state)}>
                  {t("cancel")}
                </Button>
                <Button
                  type="button"
                  loading={state.busy}
                  disabled={!state.dirty}
                  onClick={async () => {
                    if (await state.saveAll()) onOpenChange(false);
                  }}
                >
                  {t(subscription ? "save" : "create")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <ConfirmDialog
            open={confirmDiscard && state.dirty}
            onOpenChange={setConfirmDiscard}
            title={bar("discardTitle")}
            description={bar("discardDescription")}
            cancelLabel={bar("continueEditing")}
            confirmLabel={bar("discardChanges")}
            onConfirm={() => close(state)}
          />
        </>
      )}
    >
      {null}
    </SaveScope>
  );
}
