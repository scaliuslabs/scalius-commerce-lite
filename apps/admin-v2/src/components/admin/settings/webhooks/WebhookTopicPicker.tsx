import { useId, type ReactNode } from "react";
import {
  EVENT_TOPIC_FILTERS,
  EVENT_TOPIC_PREFIXES,
  EVENT_TOPICS,
  isEventTopicFilter,
  normalizeEventTopicFilters,
  type EventTopic,
  type EventTopicFilter,
} from "@scalius/shared/events";
import { Checkbox } from "~/components/ui/checkbox";
import { useMessages } from "~/i18n";
import { webhookTopicMessages } from "~/i18n/settings-webhooks";

/**
 * The filters a subscription sends: catalog filters only (the API accepts no
 * other), covered exact topics dropped, sorted in catalog order.
 */
export function normalizeTopics(topics: Iterable<string>): EventTopicFilter[] {
  return normalizeEventTopicFilters([...topics].filter(isEventTopicFilter)) ?? [];
}

interface TopicGroup {
  filter: `${(typeof EVENT_TOPIC_PREFIXES)[number]}.*`;
  topics: EventTopic[];
}

/** Groups by resource, limited to the filters the API accepts. */
function topicGroups(accepted: ReadonlySet<string>): TopicGroup[] {
  return EVENT_TOPIC_PREFIXES.map((prefix) => ({
    filter: `${prefix}.*` as const,
    topics: EVENT_TOPICS.filter((topic) => topic.startsWith(`${prefix}.`) && accepted.has(topic)),
  })).filter((group) => accepted.has(group.filter) || group.topics.length > 0);
}

function Choice({ checked, disabled, onChange, strong, children }: {
  checked: boolean | "indeterminate";
  disabled?: boolean;
  onChange: (on: boolean) => void;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={strong ? "flex min-h-11 items-start gap-3 px-3 py-2.5 text-body font-medium" : "flex min-h-9 items-start gap-3 py-1.5 text-body"}>
      <span className="flex h-lh items-center">
        <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => onChange(value === true)} />
      </span>
      {children}
    </label>
  );
}

/**
 * Events for one webhook: "All events", then each resource's "All … events"
 * (also future topics of that resource) above its exact topics. A covering
 * choice shows what it covers as ticked and locked; the merchant's own picks
 * underneath come back if they untick it.
 */
export function WebhookTopicPicker({
  id,
  value,
  onChange,
  topicFilters,
  disabled = false,
  invalid = false,
}: {
  id: string;
  value: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  /** The filters the API accepts (the list response); empty means the whole catalog. */
  topicFilters: readonly string[];
  disabled?: boolean;
  invalid?: boolean;
}) {
  const label = useMessages(webhookTopicMessages);
  const groupId = useId();
  const accepted = new Set<string>(topicFilters.length > 0 ? topicFilters : EVENT_TOPIC_FILTERS);
  const everything = value.has("*");
  const toggle = (filter: EventTopicFilter, on: boolean) => {
    const next = new Set(value);
    if (on) next.add(filter);
    else next.delete(filter);
    onChange(next);
  };
  return (
    <div
      id={id}
      role="group"
      aria-invalid={invalid || undefined}
      aria-describedby={`${id}-note`}
      className="divide-y divide-border rounded-lg border border-input aria-invalid:border-destructive"
    >
      {accepted.has("*") ? (
        <Choice strong checked={everything} disabled={disabled} onChange={(on) => toggle("*", on)}>
          {label("*")}
        </Choice>
      ) : null}
      {topicGroups(accepted).map((group) => {
        const whole = everything || value.has(group.filter);
        const some = group.topics.some((topic) => value.has(topic));
        return (
          <div key={group.filter} role="group" aria-labelledby={`${groupId}-${group.filter}`}>
            <Choice
              strong
              checked={whole ? true : some ? "indeterminate" : false}
              disabled={disabled || everything || !accepted.has(group.filter)}
              onChange={(on) => toggle(group.filter, on)}
            >
              <span id={`${groupId}-${group.filter}`}>{label(group.filter)}</span>
            </Choice>
            {group.topics.length > 0 ? (
              <div className="grid gap-x-4 pb-2 ps-10 pe-3 sm:grid-cols-2">
                {group.topics.map((topic) => (
                  <Choice
                    key={topic}
                    checked={whole || value.has(topic)}
                    disabled={disabled || whole}
                    onChange={(on) => toggle(topic, on)}
                  >
                    {label(topic)}
                  </Choice>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
