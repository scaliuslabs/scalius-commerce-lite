import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CUSTOMER_TAGS_PER_CUSTOMER_MAX } from "@scalius/shared/customer-marketing";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
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
    invalid: !canEdit,
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
        <Field
          id="customer-tags"
          label={t("addTag")}
          hideLabel
          help={canEdit ? t("tagsHelp") : tags.length === 0 ? t("noTagsYet") : undefined}
        >
        <TagInput
          id="customer-tags"
          value={tags}
          onChange={setTags}
          max={CUSTOMER_TAGS_PER_CUSTOMER_MAX}
          disabled={!canEdit}
          aria-describedby={canEdit ? "customer-tags-help" : undefined}
        />
        </Field>
      </CardContent>
    </Card>
  );
}
