import { putApiV1AdminSettingsConversationTopics } from "@scalius/api-client/sdk";
import { CONVERSATION_TOPIC_LIMITS, type ConversationTopic } from "@scalius/shared/conversation";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData } from "~/lib/api";
import { conversationTopicsQuery } from "~/lib/api-query-options/settings-screens";
import { storeLanguagesQueryOptions } from "~/lib/api-query-options/translations";
import { useLocale, useMessages } from "~/i18n";
import { conversationTopicsMessages } from "~/i18n/conversation-topics";
import { settingsMessages } from "~/i18n/settings";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading } from "./SettingsPage";

type Values = { messageTopics: ConversationTopic[] };

/**
 * A new topic's key, which conversations keep: its name in lowercase Latin
 * letters and digits joined by `-`, or `topic-<n>` when the name has none
 * (a Bangla name), never one another topic has. The merchant never types it,
 * and a saved topic keeps its key when renamed.
 */
export function topicKeyFor(label: string, taken: ReadonlySet<string>): string {
  const fromName = label.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, CONVERSATION_TOPIC_LIMITS.keyLength);
  if (fromName && !taken.has(fromName)) return fromName;
  for (let n = 1; ; n += 1) if (!taken.has(`topic-${n}`)) return `topic-${n}`;
}

/** Whether a row's names are sound: a default name, and each other language's name one line within the limit. */
export function topicNamesValid(topic: ConversationTopic): boolean {
  const ok = (text: string) => text.trim().length <= CONVERSATION_TOPIC_LIMITS.labelLength && !/[\r\n]/.test(text);
  return Boolean(topic.label.trim()) && ok(topic.label) && Object.values(topic.labels ?? {}).every(ok);
}

function languageName(locale: string, uiLocale: string): string {
  try {
    return new Intl.DisplayNames([uiLocale], { type: "language" }).of(locale) ?? locale.toUpperCase();
  } catch {
    return locale.toUpperCase();
  }
}

/**
 * Settings → Customer accounts → Message topics: the short list buyers choose
 * from when they write to the store, named in each of the store's languages.
 * Saved whole, at the revision it loaded.
 */
export function ConversationTopicsCard() {
  const t = useMessages(conversationTopicsMessages);
  const common = useMessages(settingsMessages);
  const uiLocale = useLocale();
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const savedKeys = new Set(useQuery({ queryKey: conversationTopicsQuery.queryKey, queryFn: conversationTopicsQuery.queryFn }).data?.messageTopics.map((topic) => topic.key) ?? []);
  const otherLanguages = (useQuery(storeLanguagesQueryOptions()).data ?? []).filter((language) => !language.isDefault).map((language) => language.locale);
  const { values, setValue, isLoadError, refetch } = useSettingsForm<Values, Values & { revision: number }, number>({
    label: t("title"),
    queryKey: conversationTopicsQuery.queryKey,
    fetchFn: conversationTopicsQuery.queryFn,
    saveFn: ({ messageTopics }, expectedRevision) =>
      apiData(putApiV1AdminSettingsConversationTopics({ body: { messageTopics, expectedRevision } })),
    resolveSavedValues: (result) => ({ messageTopics: result.messageTopics }),
    defaultValues: { messageTopics: undefined as unknown as ConversationTopic[] },
    errorMessage: common("saveFailed"),
    canEdit,
    fields: (path) => {
      const index = /^messageTopics\.(\d+)/.exec(path)?.[1];
      return index === undefined ? undefined : `topic-${index}-label`;
    },
    isValid: ({ messageTopics }) => Boolean(messageTopics) && messageTopics.every(topicNamesValid),
  });
  if (isLoadError) return <SettingsLoadFailure title={t("load")} onRetry={refetch} />;
  if (!values.messageTopics) return <SettingsCardLoading />;
  const topics = values.messageTopics;
  const set = (next: ConversationTopic[]) => setValue("messageTopics", next);
  const rename = (index: number, label: string) => set(topics.map((topic, at) => {
    if (at !== index) return topic;
    // A topic not saved yet takes its key from its name; a saved one keeps its key.
    if (savedKeys.has(topic.key)) return { ...topic, label };
    const taken = new Set([...savedKeys, ...topics.filter((_, other) => other !== index).map((other) => other.key)]);
    return { ...topic, label, key: topicKeyFor(label, taken) };
  }));
  const translate = (index: number, locale: string, text: string) => set(topics.map((topic, at) => {
    if (at !== index) return topic;
    const labels = { ...(topic.labels ?? {}), [locale]: text };
    if (!text.trim()) delete labels[locale];
    return { ...topic, labels };
  }));

  return (
    <SettingsCard id="conversationTopics" title={t("title")} description={t("description")}>
      {topics.length === 0 ? <p className="text-body text-muted-foreground">{t("empty")}</p> : null}
      <ol className="flex flex-col gap-4">
        {topics.map((topic, index) => {
          const name = topic.label.trim() || t("untitled");
          const invalid = !topicNamesValid(topic);
          return (
            <li key={topic.key || `new-${index}`} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-40 flex-1 flex-col gap-1 text-body">
                  <span>{t("name")}</span>
                  <Input
                    id={`topic-${index}-label`}
                    value={topic.label}
                    maxLength={CONVERSATION_TOPIC_LIMITS.labelLength}
                    disabled={!canEdit}
                    aria-invalid={invalid ? true : undefined}
                    onChange={(event) => rename(index, event.target.value)}
                  />
                </label>
                <Button type="button" variant="ghost" size="icon" aria-label={t("moveUp", { name })} disabled={!canEdit || index === 0}
                  onClick={() => set([...topics.slice(0, index - 1), topic, topics[index - 1]!, ...topics.slice(index + 1)])}>
                  <ArrowUp aria-hidden />
                </Button>
                <Button type="button" variant="ghost" size="icon" aria-label={t("remove", { name })} disabled={!canEdit}
                  onClick={() => set(topics.filter((_, at) => at !== index))}>
                  <Trash2 aria-hidden />
                </Button>
              </div>
              {otherLanguages.map((locale) => (
                <label key={locale} className="flex flex-col gap-1 text-body">
                  <span>{t("nameIn", { language: languageName(locale, uiLocale) })}</span>
                  <Input
                    id={`topic-${index}-label-${locale}`}
                    value={topic.labels?.[locale] ?? ""}
                    maxLength={CONVERSATION_TOPIC_LIMITS.labelLength}
                    disabled={!canEdit}
                    onChange={(event) => translate(index, locale, event.target.value)}
                  />
                </label>
              ))}
              {invalid ? <p className="text-body text-destructive">{t("nameRequired", { count: CONVERSATION_TOPIC_LIMITS.labelLength })}</p> : null}
            </li>
          );
        })}
      </ol>
      <div>
        <Button type="button" variant="outline" size="sm" disabled={!canEdit || topics.length >= CONVERSATION_TOPIC_LIMITS.topics}
          onClick={() => set([...topics, { key: topicKeyFor("", new Set([...savedKeys, ...topics.map((topic) => topic.key)])), label: "" }])}>
          <Plus aria-hidden />
          {t("add")}
        </Button>
      </div>
    </SettingsCard>
  );
}
