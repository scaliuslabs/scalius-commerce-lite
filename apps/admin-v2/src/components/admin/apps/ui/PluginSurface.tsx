// One app surface: asks the app's admin route for its UI document (one GET),
// checks it, and draws it, or says plainly why it can't. An app page, a
// resource card and a home widget are each one of these. Table pages
// re-request it with `cursor`; an action's `refresh` requests it again and
// its `ui` replaces the tree until then. Nothing an app sends can break the
// page around it: failures stay inside the surface. While the tree shows a
// `live` progress (a background job), the surface is read again every few
// seconds, for at most ten minutes in a row.
import { useMemo, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { parsePluginUiDocument, pluginUiHasLiveProgress, type PluginUiDocument } from "@scalius/shared/plugins/ui";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { useLocale } from "~/i18n";
import { fetchAppDocument } from "~/lib/app-route";
import { queryKeys } from "~/lib/query-keys";
import { PluginUiRenderer, type PluginUiHost } from "./PluginUiRenderer";
import { appErrorMessage } from "./run-action";
import { SurfaceLoadError, SurfaceSkeleton, UnreadableDocument } from "./surface-states";
import { isAppRouteDeclared, type AppSurfaces } from "./surfaces";

/** A drawn document stays fresh until something asks for it again (an action's refresh). */
const APP_DOCUMENT_STALE_TIME_MS = 30_000;
/** A live progress is read again this often. */
const APP_LIVE_REFRESH_MS = 3_000;
/** For at most this long in a row: a job that never finishes stops costing requests. */
const APP_LIVE_REFRESH_MAX_MS = 10 * 60_000;

/** Whether an answer is a valid document that shows a live progress (each answer checked once). */
const liveAnswers = new WeakMap<object, boolean>();
function showsLiveProgress(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  let live = liveAnswers.get(data);
  if (live === undefined) {
    const parsed = parsePluginUiDocument(data);
    live = parsed.ok && pluginUiHasLiveProgress(parsed.document.root);
    liveAnswers.set(data, live);
  }
  return live;
}

export interface PluginSurfaceProps {
  app: AppSurfaces;
  /** The admin route that answers the document (GET). */
  route: string;
  /** The request's query: a card's `resource`, `id` and `surface`, a widget's `surface`, an app-page link's query. */
  query: Readonly<Record<string, string>>;
  /** A resource card's record (actions inside it say which record they're about). */
  resource?: { target: string; id: string } | null;
  /** `tab`: one tab of an app page whose title and tabs the dashboard draws. */
  variant: "page" | "tab" | "embedded";
  /** The manifest title: the page header while loading and when the app's page names none. */
  title?: string;
  /** Beside a page's title ("Provided by <app>"). */
  badge?: ReactNode;
}

function StateFrame({ variant, title, children }: { variant: "page" | "tab" | "embedded"; title?: string; children: ReactNode }) {
  if (variant !== "page") return <>{children}</>;
  return (
    <>
      <PageHeader title={title ?? ""} />
      {children}
    </>
  );
}

export function PluginSurface({ app, route, query, resource = null, variant, title, badge }: PluginSurfaceProps) {
  // Cursors of the table pages visited; the last one is the page shown.
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const request = useMemo(() => (cursor ? { ...query, cursor } : { ...query }), [cursor, query]);
  const declared = isAppRouteDeclared(app, route, "GET");
  // The app writes in the dashboard's language: switching it asks again.
  const locale = useLocale();
  // Since when the answers have shown a live progress without a break.
  const liveSince = useRef<number | null>(null);
  const document = useQuery({
    queryKey: [...queryKeys.apps.document(app.id, route, request), locale],
    queryFn: ({ signal }) => fetchAppDocument(app.id, route, { query: request, signal }),
    enabled: declared,
    staleTime: APP_DOCUMENT_STALE_TIME_MS,
    // The page before stays on screen while the next one loads.
    placeholderData: keepPreviousData,
    refetchInterval: (query) => {
      if (!showsLiveProgress(query.state.data)) {
        liveSince.current = null;
        return false;
      }
      liveSince.current ??= Date.now();
      return Date.now() - liveSince.current < APP_LIVE_REFRESH_MAX_MS ? APP_LIVE_REFRESH_MS : false;
    },
  });
  const parsed = useMemo(() => (document.data === undefined ? null : parsePluginUiDocument(document.data)), [document.data]);
  // An action's replacement tree, shown until the document is requested again.
  const [replacement, setReplacement] = useState<{ document: PluginUiDocument; basis: number; serial: number } | null>(null);
  const shown = replacement && replacement.basis === document.dataUpdatedAt ? replacement : null;

  if (!declared) {
    return (
      <StateFrame variant={variant} title={title}>
        <UnreadableDocument reason="invalid" issues={[{ path: route, message: "Not a declared GET admin route." }]} />
      </StateFrame>
    );
  }
  if (document.isPending) return <SurfaceSkeleton variant={variant === "page" ? "page" : "embedded"} title={title} />;
  if (document.isError) {
    return (
      <StateFrame variant={variant} title={title}>
        <SurfaceLoadError
          message={appErrorMessage(document.error, "loadFailedBody")}
          retrying={document.isFetching}
          onRetry={() => void document.refetch()}
        />
      </StateFrame>
    );
  }
  let tree: PluginUiDocument;
  if (shown) tree = shown.document;
  else if (parsed?.ok) tree = parsed.document;
  else {
    return (
      <StateFrame variant={variant} title={title}>
        <UnreadableDocument reason={parsed && !parsed.ok ? parsed.reason : "invalid"} issues={parsed && !parsed.ok ? parsed.issues : []} />
      </StateFrame>
    );
  }
  const host: PluginUiHost = {
    app,
    resource,
    refresh: () => {
      setReplacement(null);
      void document.refetch();
    },
    replace: (next) => setReplacement((current) => ({ document: next, basis: document.dataUpdatedAt, serial: (current?.serial ?? 0) + 1 })),
    paginate: {
      go: (next) => setCursors((visited) => [...visited, next]),
      back: cursors.length > 0 ? () => setCursors((visited) => visited.slice(0, -1)) : null,
    },
  };
  // A new answer (or replacement) starts its forms afresh.
  return (
    <PluginUiRenderer
      key={`${document.dataUpdatedAt}:${shown?.serial ?? 0}`}
      document={tree}
      host={host}
      variant={variant}
      fallbackTitle={title}
      badge={badge}
    />
  );
}
