import { useImperativeHandle, useState, type KeyboardEvent, type Ref } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { CUSTOMER_TAG_MAX_LENGTH } from "@scalius/shared/customer-marketing";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useDebounce } from "~/hooks/use-debounce";
import { useMessages } from "~/i18n";
import { customersMessages } from "~/i18n/customers";
import { customerTagsQueryOptions } from "~/lib/api-query-options/customers";
import { addTypedTags } from "./tag-input";

/** Suggestions shown under the field. */
const SUGGESTIONS = 8;

export interface TagInputHandle {
  /** Turns text still in the field into tags now and returns the whole list (a dialog's Apply calls it). */
  flush: () => string[];
}

interface TagInputProps {
  id: string;
  value: readonly string[];
  onChange: (tags: string[]) => void;
  /** At most this many tags (50 on a customer, 10 in one bulk change). */
  max: number;
  disabled?: boolean;
  /** Offer tags already in use (most used first, narrowed by what is typed). */
  suggest?: boolean;
  /** Whether text is typed but not yet a tag (it becomes one when the field is left). */
  onPendingTextChange?: (pending: boolean) => void;
  handle?: Ref<TagInputHandle>;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/**
 * Customer tags as chips: type a tag and press Enter or a comma (or paste
 * "vip, wholesale"); Backspace in the empty field removes the last one. Tags
 * are normalised as stored (lower-case, single spaces), at most 40 characters.
 */
export function TagInput({
  id,
  value,
  onChange,
  max,
  disabled = false,
  suggest = true,
  onPendingTextChange,
  handle,
  ...aria
}: TagInputProps) {
  const t = useMessages(customersMessages);
  const [text, setTextState] = useState("");
  const setText = (next: string) => {
    setTextState(next);
    onPendingTextChange?.(next.trim() !== "");
  };
  const [problem, setProblem] = useState<string | null>(null);
  // Suggestions appear once the field is used and then stay, so a click on one never moves.
  const [engaged, setEngaged] = useState(false);
  const query = useDebounce(text.trim(), 250);
  const suggestions = useQuery({
    ...customerTagsQueryOptions(query),
    enabled: suggest && engaged && !disabled,
    placeholderData: keepPreviousData,
  });
  const offered = (suggestions.data?.tags ?? [])
    .filter((entry) => !value.includes(entry.tag))
    .slice(0, SUGGESTIONS);
  const full = value.length >= max;

  const commit = (typed: string): string[] => {
    if (!typed.trim()) {
      setText("");
      return [...value];
    }
    const result = addTypedTags(value, typed, max);
    if (result.tags.length !== value.length) onChange(result.tags);
    setProblem(
      result.invalid.length > 0
        ? t("tagTooLong", { count: CUSTOMER_TAG_MAX_LENGTH })
        : result.overflow ? t("tagLimit", { count: max }) : null,
    );
    setText("");
    return result.tags;
  };
  useImperativeHandle(handle, () => ({ flush: () => commit(text) }));

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      // Enter adds the tag; it never submits the page's form.
      event.preventDefault();
      commit(text);
    } else if (event.key === "Backspace" && text === "" && value.length > 0) {
      onChange(value.slice(0, -1));
      setProblem(null);
    }
  };

  const describedBy = [aria["aria-describedby"], problem ? `${id}-problem` : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-2">
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={t("tags")}>
          {value.map((tag) => (
            <li key={tag} className="flex min-w-0 items-center gap-1 rounded-lg bg-secondary py-0.5 ps-2 text-body">
              <span className="min-w-0 break-words">{tag}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={t("removeTag", { tag })}
                onClick={() => {
                  onChange(value.filter((other) => other !== tag));
                  setProblem(null);
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Input
        id={id}
        value={text}
        disabled={disabled || full}
        placeholder={full ? t("tagLimit", { count: max }) : t("addTag")}
        autoComplete="off"
        enterKeyHint="enter"
        aria-describedby={describedBy}
        aria-invalid={Boolean(problem) || aria["aria-invalid"] || undefined}
        onFocus={() => setEngaged(true)}
        onChange={(event) => {
          const next = event.target.value;
          // A pasted list adds every complete part and keeps the last one being typed.
          if (next.includes(",")) {
            const parts = next.split(",");
            const last = parts.pop() ?? "";
            // Once the list is full the rest can't be added either: say so rather than keep it in a closed field.
            const fills = addTypedTags(value, parts.join(","), max).tags.length >= max;
            commit(fills ? next : parts.join(","));
            if (!fills) setText(last);
          } else {
            setText(next);
            if (problem) setProblem(null);
          }
        }}
        onKeyDown={onKeyDown}
        onBlur={() => commit(text)}
      />
      {problem ? (
        <p id={`${id}-problem`} role="alert" className="text-body text-destructive">{problem}</p>
      ) : null}
      {suggest && offered.length > 0 && !full && !disabled ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={t("suggestedTags")}>
          {offered.map((entry) => (
            <li key={entry.tag}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={t("addTagNamed", { tag: entry.tag })}
                // Keeps focus in the field, so leaving it doesn't first add the half-typed text.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  onChange([...value, entry.tag].slice(0, max));
                  setText("");
                  setProblem(null);
                }}
              >
                <Plus aria-hidden="true" />
                {entry.tag}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
