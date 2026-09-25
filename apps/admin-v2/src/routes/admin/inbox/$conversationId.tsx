import { createFileRoute } from "@tanstack/react-router";
import { InboxWorkspace } from "~/components/admin/inbox/InboxWorkspace";
import { threadQueryOptions } from "~/components/admin/inbox/inbox-api";
import { validateInboxSearch } from "~/components/admin/inbox/inbox-search";
import { pageHead } from "~/i18n/page-titles";
import { RouteErrorComponent } from "~/lib/route-error";
import { warmRouteQuery } from "~/lib/route-query-warming";

/** One conversation beside the inbox list (a page of its own on phones). */
export const Route = createFileRoute("/admin/inbox/$conversationId")({
  validateSearch: validateInboxSearch,
  loader: ({ context: { queryClient }, params }) => warmRouteQuery(queryClient, threadQueryOptions(params.conversationId)),
  head: () => pageHead("inbox"),
  component: InboxConversationPage,
  errorComponent: RouteErrorComponent,
});

function InboxConversationPage() {
  const search = Route.useSearch();
  const { conversationId } = Route.useParams();
  return <InboxWorkspace search={search} selectedId={conversationId} />;
}
