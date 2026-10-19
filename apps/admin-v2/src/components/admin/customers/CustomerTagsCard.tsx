import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CUSTOMER_TAG_MAX_LENGTH, CUSTOMER_TAGS_PER_CUSTOMER_MAX } from "@scalius/shared/customer-marketing";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { useSaveBar } from "~/components/admin/shared/SaveBar";
import { saveCustomerTags } from "~/lib/api-mutations/customers";
import type { CustomerDto } from "~/lib/api-query-options/customers";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { customersMessages } from "~/i18n/customers";
import { TagInput } from "./TagInput";
import { sameTags } from "./tag-input";
import { Field } from "~/components/ui/field";

/**
 * The customer page's Tags card. Tags save with the page's save bar (like the
 * Custom data card), replacing the customer's tags in one request.
 */
export function CustomerTagsCard({ customerId, tags: loaded, canEdit }: { customerId: string; tags: readonly string[]; canEdit: boolean }) {
  const t = useMessages(customersMessages);
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState<string[]>(() => [...loaded]);
  const [tags, setTags] = useState<string[]>(() => [...loaded]);
  /** Text left in the field: one too long to be a tag stays there, so Save waits for it. */
  const [pendingText, setPendingText] = useState(false);
  const dirty = canEdit && !sameTags(tags, saved);

  // A fresh read replaces the tags only while there are no edits.
  const loadedKey = loaded.join("\n");
  useEffect(() => {
    if (dirty) return;
    setSaved([...loaded]);
    setTags([...loaded]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedKey]);

  useSaveBar({
    label: t("tags"),
    dirty,
    invalid: !canEdit || pendingText,
    save: async () => {
      const result = await saveCustomerTags(customerId, tags);
      setSaved(result.tags);
      setTags((current) => (sameTags(current, tags) ? result.tags : current));
      queryClient.setQueryData<CustomerDto>(queryKeys.customers.detail(customerId), (customer) =>
        customer ? { ...customer, tags: result.tags } : customer);
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.tags() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.marketing(customerId) });
    },
    discard: () => setTags(saved),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("tags")}</CardTitle>
      </CardHeader>
      <CardContent>
        {canEdit ? (
          <Field id="customer-tags" label={t("addTag")} hideLabel help={t("tagsHelp", { count: CUSTOMER_TAG_MAX_LENGTH })}>
            <TagInput
              id="customer-tags"
              value={tags}
              onChange={setTags}
              onPendingTextChange={setPendingText}
              max={CUSTOMER_TAGS_PER_CUSTOMER_MAX}
              aria-describedby="customer-tags-help"
            />
          </Field>
        ) : loaded.length > 0 ? (
          <ul aria-label={t("tags")} className="flex flex-wrap gap-1.5">
            {loaded.map(tag => <li key={tag} className="min-w-0 max-w-full"><Badge variant="secondary" className="max-w-full whitespace-normal break-words">{tag}</Badge></li>)}
          </ul>
        ) : <p className="text-body text-muted-foreground">{t("noTagsYet")}</p>}
      </CardContent>
    </Card>
  );
}
