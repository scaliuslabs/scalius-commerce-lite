import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { FileText, Newspaper } from "lucide-react";
import {
  postApiV1AdminPagesBulkDelete,
  postApiV1AdminPagesBulkPublish,
  postApiV1AdminPagesBulkRestore,
  postApiV1AdminPagesBulkUnpublish,
} from "@scalius/api-client/sdk";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { unixToDate } from "@scalius/shared/timestamps";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { getPagePublicationMode, isPageLive } from "~/lib/page-publication";
import { contentListQuery, type PageListItem } from "~/lib/api-query-options/pages";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { usePermissions } from "~/contexts/PermissionContext";
import { Button } from "~/components/ui/button";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { ResourceListPage, ResourceRowLink, inChunks, useResourceMutation, type BulkRun } from "~/components/admin/resource/ResourceListPage";
import type { BulkTarget } from "~/lib/bulk-selection";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { sortHeader } from "~/components/admin/resource/columns";
import { ListDate } from "~/components/admin/data-table/ListDate";
import { formatDateTime, useMessages } from "~/i18n";
import { contentMessages } from "~/i18n/content";
import { contentListName, type ContentType, type validatePageSearch } from "./page-list-state";
import { useListSearch } from "~/lib/list-search";

const INVALIDATE = [queryKeys.pages.all];
const claims = (rows: PageListItem[]) => rows.map((row) => ({ id: row.id, expectedRevision: row.revision }));

/** Pages and blog posts share one list; only paths and copy differ. */
export function ContentList({ type, search }: { type: ContentType; search: ReturnType<typeof validatePageSearch> }) {
  const t = useMessages(contentMessages);
  const [term] = useListSearch(contentListName(type));
  const { hasPermission } = usePermissions();
  const { getStorefrontPath } = useStorefrontUrl();
  const canEdit = hasPermission(PERMISSIONS.PAGES_EDIT);
  const canDelete = hasPermission(PERMISSIONS.PAGES_DELETE);
  const canPublish = hasPermission(PERMISSIONS.PAGES_PUBLISH);
  const isBlog = type === "article";
  const base = isBlog ? "/admin/articles" : "/admin/pages";
  const editTo = (row: PageListItem) => (canEdit ? `${base}/${row.id}/edit` : undefined);
  // The list's filter as "all matching" actions send it (the API reads the pages itself).
  const matchingFilter = {
    contentType: type,
    ...(term ? { search: term } : {}),
    ...(search.status && !search.trashed ? { status: search.status } : {}),
  };
  const matchingSlice = (cursor: string | undefined) => ({ matching: { filter: matchingFilter, ...(cursor ? { cursor } : {}) } });
  const publish = useResourceMutation(
    async ({ target, live, run }: { target: BulkTarget<PageListItem>; live: boolean; run: BulkRun }) => {
      const send = (body: Parameters<typeof postApiV1AdminPagesBulkPublish>[0]["body"]) => apiData(live
        ? postApiV1AdminPagesBulkPublish({ body })
        : postApiV1AdminPagesBulkUnpublish({ body }));
      if (target.kind === "rows") {
        await inChunks(target.rows, (chunk) => send({ pages: claims(chunk) }));
        return;
      }
      await run.matching(t(live ? "publishing" : "unpublishing"), async (cursor) => {
        const result = await send(matchingSlice(cursor));
        return result.matching ?? { processed: 0, skipped: 0, next: null };
      });
    },
    INVALIDATE,
  );

  const columns = useMemo<ColumnDef<PageListItem, unknown>[]>(() => [
    {
      accessorKey: "title",
      header: sortHeader(isBlog ? t("blogPost") : t("page")),
      meta: { mobile: "primary", minWidth: 220 },
      cell: ({ row }) => <ResourceRowLink to={search.trashed ? undefined : editTo(row.original)}>{row.original.title}</ResourceRowLink>,
    },
    {
      id: "status",
      header: t("status"),
      meta: { mobile: "status", priority: 80, minWidth: 110 },
      cell: ({ row }) => {
        const mode = getPagePublicationMode(row.original);
        return <StatusBadge status={mode === "published" ? "active" : mode}>{t(mode === "published" ? "visible" : mode)}</StatusBadge>;
      },
    },
    {
      accessorKey: "updatedAt",
      header: sortHeader(t("updated")),
      meta: { mobile: "secondary", priority: 50, minWidth: 140 },
      cell: ({ row }) => {
        const publishAt = unixToDate(row.original.publishedAt);
        return getPagePublicationMode(row.original) === "scheduled" && publishAt ? (
          <span className="whitespace-nowrap text-muted-foreground">{t("publishesOn", { date: formatDateTime(publishAt, { dateStyle: "medium", timeStyle: "short" }) })}</span>
        ) : (
          <ListDate value={row.original.updatedAt} />
        );
      },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [t, isBlog, search.trashed, canEdit]);

  return (
    <ResourceListPage<PageListItem>
      title={isBlog ? t("blogPosts") : t("pages")}
      actions={hasPermission(PERMISSIONS.PAGES_CREATE) ? (
        <Button asChild>
          <Link to={isBlog ? "/admin/articles/new" : "/admin/pages/new"}>{isBlog ? t("addBlogPost") : t("addPage")}</Link>
        </Button>
      ) : null}
      search={search}
      list={contentListName(type)}
      appActions={isBlog ? undefined : "page"}
      query={contentListQuery(type, search, term)}
      dataKey="pages"
      columns={columns}
      invalidate={INVALIDATE}
      empty={isBlog
        ? { icon: Newspaper, title: t("blogEmptyTitle"), description: t("blogEmptyBody") }
        : { icon: FileText, title: t("pagesEmptyTitle"), description: t("pagesEmptyBody") }}
      views={{ param: "status", tabs: [
        { value: "published", label: t("visible") },
        { value: "scheduled", label: t("scheduled") },
        { value: "draft", label: t("draft") },
      ] }}
      rowTo={editTo}
      rowLabel={(row) => row.title}
      viewUrl={(row) => (isPageLive(row) ? getStorefrontPath(isBlog ? `/blog/${row.slug}` : `/${row.slug}`) : undefined)}
      matchingBulk
      bulkActions={canPublish ? (target, done, run) => (
        <>
          <Button variant="outline" disabled={publish.isPending} onClick={() => publish.mutate({ variables: { target, live: true, run }, success: t("published") }, { onSuccess: done })}>
            {t("publish")}
          </Button>
          <Button variant="outline" disabled={publish.isPending} onClick={() => publish.mutate({ variables: { target, live: false, run }, success: t("movedToDraft") }, { onSuccess: done })}>
            {t("unpublish")}
          </Button>
        </>
      ) : undefined}
      lifecycle={{
        canTrash: canDelete,
        // Restore is an edit on the API; permanent delete needs delete.
        canRestore: canEdit,
        canDelete,
        run: (action, rows) =>
          action === "restore"
            ? apiData(postApiV1AdminPagesBulkRestore({ body: { pages: claims(rows) } }))
            : apiData(postApiV1AdminPagesBulkDelete({ body: { pages: claims(rows), permanent: action === "delete" } })),
        runMatching: async (action, cursor) => {
          const result = action === "restore"
            ? await apiData(postApiV1AdminPagesBulkRestore({ body: matchingSlice(cursor) }))
            : await apiData(postApiV1AdminPagesBulkDelete({ body: { ...matchingSlice(cursor), permanent: action === "delete" } }));
          return result.matching ?? { processed: 0, skipped: 0, next: null };
        },
      }}
    />
  );
}
