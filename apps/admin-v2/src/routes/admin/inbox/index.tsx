import { createFileRoute } from "@tanstack/react-router";
import { InboxWorkspace } from "~/components/admin/inbox/InboxWorkspace";
import { validateInboxSearch } from "~/components/admin/inbox/inbox-search";
import { pageHead } from "~/i18n/page-titles";
import { RouteErrorComponent } from "~/lib/route-error";

/** The inbox list; on wide screens the empty conversation pane sits beside it. */
export const Route = createFileRoute("/admin/inbox/")({
  validateSearch: validateInboxSearch,
  head: () => pageHead("inbox"),
  component: InboxIndexPage,
  errorComponent: RouteErrorComponent,
});

function InboxIndexPage() {
  const search = Route.useSearch();
  return <InboxWorkspace search={search} selectedId={null} />;
}
