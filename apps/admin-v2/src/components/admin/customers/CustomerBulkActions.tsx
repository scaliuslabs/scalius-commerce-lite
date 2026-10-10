import { useRef, useState } from "react";
import { CUSTOMER_TAGS_PER_REQUEST_MAX } from "@scalius/shared/customer-marketing";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { useResourceMutation, type BulkRun } from "~/components/admin/resource/ResourceListPage";
import type { BulkTarget } from "~/lib/bulk-selection";
import { bulkUpdateCustomerTags } from "~/lib/api-mutations/customers";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { customerBulkMessages } from "~/i18n/customer-bulk";
import { customersMessages } from "~/i18n/customers";
import { resourceMessages } from "~/i18n/resource";
import { TagInput, type TagInputHandle } from "./TagInput";
import { Field } from "~/components/ui/field";

type Mode = "add" | "remove";

/** One bulk tag request takes at most this many customers. */
const BULK_TAG_CUSTOMERS = 500;

/**
 * The customers list's bulk actions: add or remove tags on the selected
 * customers (one dialog), and export them. On "all matching" customers the
 * tags go to every customer the list's filter matches, slice by slice on the
 * server; the export then exports the filter.
 */
export function CustomerBulkActions({
  target,
  filter,
  run,
  done,
  canEdit,
  onExport,
}: {
  target: BulkTarget<{ id: string }>;
  /** The list's filter, for a `matching` target. */
  filter: Record<string, unknown>;
  run: BulkRun;
  done: () => void;
  canEdit: boolean;
  onExport: () => void;
}) {
  const t = useMessages(customersMessages);
  const b = useMessages(customerBulkMessages);
  const r = useMessages(resourceMessages);
  const [mode, setMode] = useState<Mode | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const input = useRef<TagInputHandle>(null);
  const count = target.kind === "rows" ? target.rows.length : target.count;

  const change = useResourceMutation(async ({ mode: action, tags: chosen }: { mode: Mode; tags: string[] }) => {
    const changes = action === "add" ? { add: chosen } : { remove: chosen };
    if (target.kind === "matching") {
      setMode(null);
      await run.matching(b(action === "add" ? "addingTags" : "removingTags"), async (cursor) => {
        const result = await bulkUpdateCustomerTags({ ...changes, matching: { filter, ...(cursor ? { cursor } : {}) } });
        return (result as { matching?: { processed: number; skipped: number; next: string | null } }).matching ?? { processed: 0, skipped: 0, next: null };
      });
      return;
    }
    const ids = target.rows.map((row) => row.id);
    for (let start = 0; start < ids.length; start += BULK_TAG_CUSTOMERS) {
      const customerIds = ids.slice(start, start + BULK_TAG_CUSTOMERS);
      await bulkUpdateCustomerTags(action === "add" ? { customerIds, add: chosen } : { customerIds, remove: chosen });
    }
  }, [queryKeys.customers.all]);

  const open = (next: Mode) => {
    setTags([]);
    setPending(false);
    setMode(next);
  };
  const close = () => {
    if (!change.isPending) setMode(null);
  };
  const apply = () => {
    // Text still in the field counts: it becomes a tag first.
    const chosen = input.current?.flush() ?? tags;
    if (!mode || chosen.length === 0) return;
    change.mutate(
      { variables: { mode, tags: chosen }, success: b(mode === "add" ? "tagsAdded" : "tagsRemoved") },
      {
        onSuccess: () => {
          setMode(null);
          done();
        },
      },
    );
  };
  const title = mode === "remove"
    ? count === 1 ? b("removeTagsTitleOne") : b("removeTagsTitle", { count })
    : count === 1 ? b("addTagsTitleOne") : b("addTagsTitle", { count });

  return (
    <>
      {canEdit ? (
        <>
          <Button type="button" variant="outline" onClick={() => open("add")}>{b("addTags")}</Button>
          <Button type="button" variant="outline" onClick={() => open("remove")}>{b("removeTags")}</Button>
        </>
      ) : null}
      <Button type="button" variant="outline" onClick={onExport}>{t("export")}</Button>

      <Dialog open={mode !== null} onOpenChange={(next) => { if (!next) close(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{b("bulkTagsHelp", { count: CUSTOMER_TAGS_PER_REQUEST_MAX })}</DialogDescription>
          </DialogHeader>
          <Field id="customer-bulk-tags" label={t("tags")} help={t("tagsHelp")}>
            <TagInput
              id="customer-bulk-tags"
              value={tags}
              onChange={setTags}
              max={CUSTOMER_TAGS_PER_REQUEST_MAX}
              disabled={change.isPending}
              onPendingTextChange={setPending}
              handle={input}
              aria-describedby="customer-bulk-tags-help"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={change.isPending} onClick={close}>{r("cancel")}</Button>
            <Button type="button" disabled={tags.length === 0 && !pending} loading={change.isPending} onClick={apply}>
              {mode === "remove" ? b("removeTags") : b("addTags")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
