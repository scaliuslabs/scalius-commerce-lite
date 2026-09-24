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
import type { PageListItem } from "~/lib/api-query-options/pages";
import { useStorefrontUrl } from "~/hooks/use-storefront-url";
import { usePermissions } from "~/contexts/PermissionContext";
import { Button } from "~/components/ui/button";
import type { ColumnDef } from "~/components/admin/data-table/table-config";
import { ResourceListPage, ResourceRowLink, inChunks, useResourceMutation } from "~/components/admin/resource/ResourceListPage";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { DateText, sortHeader } from "~/components/admin/resource/columns";
import { formatDateTime, useMessages } from "~/i18n";
import { contentMessages } from "~/i18n/content";
import { contentListName, contentListQuery, type ContentType, type validatePageSearch } from "./page-list-state";
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
  const publish = useResourceMutation(
    ({ rows, live }: { rows: PageListItem[]; live: boolean }) =>
      inChunks(rows, (chunk) =>
        live
          ? apiData(postApiV1AdminPagesBulkPublish({ body: { pages: claims(chunk) } }))
          : apiData(postApiV1AdminPagesBulkUnpublish({ body: { pages: claims(chunk) } })),
      ),
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
        return <StatusBadge tone={mode === "published" ? "success" : "neutral"}>{t(mode === "published" ? "visible" : mode)}</StatusBadge>;
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
          <DateText value={row.original.updatedAt} />
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
      query={contentListQuery(type, search, term)}
      pageQuery={(page, limit) => contentListQuery(type, { ...search, page, limit }, term)}
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
      bulkActions={canPublish ? (rows, done) => (
        <>
          <Button variant="outline" size="sm" disabled={publish.isPending} onClick={() => publish.mutate({ variables: { rows, live: true }, success: t("published") }, { onSuccess: done })}>
            {t("publish")}
          </Button>
          <Button variant="outline" size="sm" disabled={publish.isPending} onClick={() => publish.mutate({ variables: { rows, live: false }, success: t("movedToDraft") }, { onSuccess: done })}>
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
      }}
    />
  );
}
