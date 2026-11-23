import { putApiV1AdminSettingsConversationTopics } from "@scalius/api-client/sdk";
import { CONVERSATION_TOPIC_LIMITS, isConversationTopicKey, type ConversationTopic } from "@scalius/shared/conversation";
import { ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiData } from "~/lib/api";
import { conversationTopicsQuery } from "~/lib/api-query-options/settings-screens";
import { useMessages } from "~/i18n";
import { conversationTopicsMessages } from "~/i18n/conversation-topics";
import { settingsMessages } from "~/i18n/settings";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading } from "./SettingsPage";

type Values = { topics: ConversationTopic[] };

/** A key from a name: lowercase letters and digits joined by `-` (the merchant may change it). */
export function topicKeyOf(label: string): string {
  return label.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, CONVERSATION_TOPIC_LIMITS.keyLength);
}

/** What is wrong with a row, or null: an empty or long name, a bad key, a key used twice. */
export function topicProblem(topics: readonly ConversationTopic[], index: number): "name" | "key" | "taken" | null {
  const topic = topics[index]!;
  const name = topic.label.trim();
  if (!name || name.length > CONVERSATION_TOPIC_LIMITS.labelLength) return "name";
  if (!isConversationTopicKey(topic.key)) return "key";
  return topics.findIndex((other) => other.key === topic.key) === index ? null : "taken";
}

/**
 * Settings → Customer accounts → Message topics: the short list buyers choose
 * from when they write to the store. Saved whole, at the revision it loaded.
 */
export function ConversationTopicsCard() {
  const t = useMessages(conversationTopicsMessages);
  const common = useMessages(settingsMessages);
  const canEdit = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const { values, setValue, isLoadError, refetch } = useSettingsForm<Values, Values & { revision: number }, number>({
    label: t("title"),
    queryKey: conversationTopicsQuery.queryKey,
    fetchFn: conversationTopicsQuery.queryFn,
    saveFn: ({ topics }, expectedRevision) =>
      apiData(putApiV1AdminSettingsConversationTopics({ body: { topics, expectedRevision } })),
    resolveSavedValues: (result) => ({ topics: result.topics }),
    defaultValues: { topics: undefined as unknown as ConversationTopic[] },
    errorMessage: common("saveFailed"),
    canEdit,
    fields: (path) => {
      const index = /^topics\.(\d+)/.exec(path)?.[1];
      return index === undefined ? undefined : `topic-${index}-label`;
    },
    isValid: ({ topics }) => Boolean(topics) && topics.every((_, index) => topicProblem(topics, index) === null),
  });
  if (isLoadError) return <SettingsLoadFailure title={t("load")} onRetry={refetch} />;
  if (!values.topics) return <SettingsCardLoading />;
  const topics = values.topics;
  const set = (next: ConversationTopic[]) => setValue("topics", next);
  const update = (index: number, patch: Partial<ConversationTopic>) =>
    set(topics.map((topic, at) => (at === index ? { ...topic, ...patch } : topic)));
  const errorOf = (index: number) => {
    const problem = topicProblem(topics, index);
    if (problem === "name") return t("nameRequired", { count: CONVERSATION_TOPIC_LIMITS.labelLength });
    if (problem === "key") return t("keyInvalid", { count: CONVERSATION_TOPIC_LIMITS.keyLength });
    return problem === "taken" ? t("keyTaken") : undefined;
  };

  return (
    <SettingsCard id="conversationTopics" title={t("title")} description={t("description")}>
      {topics.length === 0 ? <p className="text-body text-muted-foreground">{t("empty")}</p> : null}
      <ol className="flex flex-col gap-3">
        {topics.map((topic, index) => {
          const error = errorOf(index);
          const name = topic.label.trim() || topic.key;
          return (
            <li key={index} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-40 flex-1 flex-col gap-1 text-body">
                  <span>{t("name")}</span>
                  <Input
                    id={`topic-${index}-label`}
                    value={topic.label}
                    maxLength={CONVERSATION_TOPIC_LIMITS.labelLength}
                    disabled={!canEdit}
                    aria-invalid={error ? true : undefined}
                    onChange={(event) => {
                      const label = event.target.value;
                      // A new topic's key follows its name until the merchant edits the key.
                      update(index, topic.key === topicKeyOf(topic.label) ? { label, key: topicKeyOf(label) } : { label });
                    }}
                  />
                </label>
                <label className="flex w-40 flex-col gap-1 text-body">
                  <span>{t("key")}</span>
                  <Input
                    id={`topic-${index}-key`}
                    value={topic.key}
                    maxLength={CONVERSATION_TOPIC_LIMITS.keyLength}
                    disabled={!canEdit}
                    title={t("keyHelp")}
                    onChange={(event) => update(index, { key: event.target.value.trim().toLowerCase() })}
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
              {error ? <p className="text-body text-destructive">{error}</p> : null}
            </li>
          );
        })}
      </ol>
      <div>
        <Button type="button" variant="outline" size="sm" disabled={!canEdit || topics.length >= CONVERSATION_TOPIC_LIMITS.topics}
          onClick={() => set([...topics, { key: "", label: "" }])}>
          <Plus aria-hidden />
          {t("add")}
        </Button>
      </div>
    </SettingsCard>
  );
}
