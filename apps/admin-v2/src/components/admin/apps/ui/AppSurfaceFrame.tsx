// The frames of apps' cards and Home widgets (loaded by AppResourceCards once
// an app has one to show). Each card is isolated: it asks its app only once
// it scrolls into view (never holding up the page's own data), makes one
// request, shows a skeleton meanwhile, and keeps any failure (a slow app, a
// crash, an unreadable answer) inside itself with a retry. The renderer and
// UI schema load on demand after that.
import { Component, Suspense, lazy, useEffect, useId, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { useMessages } from "~/i18n";
import { appUiMessages } from "~/i18n/app-ui";
import { SurfaceLoadError, SurfaceSkeleton } from "./surface-states";
import type { AppCard, AppSurfaces, AppTarget, AppWidget } from "./surfaces";

const PluginSurface = lazy(() => import("./PluginSurface").then((module) => ({ default: module.PluginSurface })));

/** True once the element has come near the viewport (at once where there is no IntersectionObserver). */
function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const node = ref.current;
    if (seen || !node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setSeen(true);
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

/** Keeps a crash inside one app surface; Retry mounts it again. */
class SurfaceBoundary extends Component<{ children: ReactNode; fallback: (retry: () => void) => ReactNode }, { error: Error | null; attempt: number }> {
  state = { error: null as Error | null, attempt: 0 };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("An app surface failed to render:", error, info);
  }

  retry = () => this.setState((state) => ({ error: null, attempt: state.attempt + 1 }));

  render() {
    if (this.state.error) return this.props.fallback(this.retry);
    return <div key={this.state.attempt}>{this.props.children}</div>;
  }
}

function CrashFallback({ retry }: { retry: () => void }) {
  const t = useMessages(appUiMessages);
  return <SurfaceLoadError message={t("loadFailedBody")} onRetry={retry} />;
}

interface FrameProps {
  app: AppSurfaces;
  title: string;
  route: string;
  query: Readonly<Record<string, string>>;
  resource?: { target: string; id: string } | null;
  /** Inside another card (a return, a variant): a bordered section instead of a card. */
  inline?: boolean;
  /** The title's heading level: 2 for a page's own cards, 3 under a section heading or inside a card. */
  level?: 2 | 3;
}

/** One app card or widget: a collapsible header (its title and app), then the app's tree. */
function AppSurfaceFrame({ app, title, route, query, resource = null, inline = false, level = inline ? 3 : 2 }: FrameProps) {
  const t = useMessages(appUiMessages);
  const [open, setOpen] = useState(true);
  const [ref, seen] = useSeen<HTMLDivElement>();
  const contentId = useId();
  const Heading = level === 2 ? "h2" : "h3";
  const header = (
    <Heading className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="min-w-0 flex-1">
          <span className="block break-words text-heading-sm">{title}</span>
          <span className="block break-words text-body text-muted-foreground">{t("fromApp", { app: app.name })}</span>
        </span>
        <ChevronDown aria-hidden="true" className={open ? "size-4 shrink-0 rotate-180" : "size-4 shrink-0"} />
      </button>
    </Heading>
  );
  const body = seen ? (
    <SurfaceBoundary fallback={(retry) => <CrashFallback retry={retry} />}>
      <Suspense fallback={<SurfaceSkeleton variant="embedded" />}>
        <PluginSurface app={app} route={route} query={query} resource={resource} variant="embedded" />
      </Suspense>
    </SurfaceBoundary>
  ) : <SurfaceSkeleton variant="embedded" />;

  if (inline) {
    return (
      <div ref={ref} data-app-surface={app.id} className="space-y-2 border-t pt-3">
        {header}
        <div id={contentId} hidden={!open}>{body}</div>
      </div>
    );
  }
  return (
    <Card ref={ref} data-app-surface={app.id}>
      <CardHeader>{header}</CardHeader>
      <CardContent id={contentId} hidden={!open}>{body}</CardContent>
    </Card>
  );
}

/** The cards apps declared for one resource (AppResourceCards checked there is one). */
export function AppCardList({ cards, target, id, inline, className }: {
  cards: ReadonlyArray<{ app: AppSurfaces; card: AppCard }>;
  target: AppTarget;
  id: string;
  inline: boolean;
  className: string;
}) {
  return (
    <div className={className}>
      {cards.map(({ app, card }) => (
        <AppSurfaceFrame
          key={`${app.id}:${card.id}`}
          app={app}
          title={card.title}
          route={card.route}
          query={{ resource: target, id, surface: card.id }}
          resource={{ target, id }}
          inline={inline}
        />
      ))}
    </div>
  );
}

/** Apps' widgets on Home, one card each. */
export function AppWidgetSection({ widgets }: { widgets: ReadonlyArray<{ app: AppSurfaces; widget: AppWidget }> }) {
  const t = useMessages(appUiMessages);
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-heading-md">{t("widgetsTitle")}</h2>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {widgets.map(({ app, widget }) => (
          <AppSurfaceFrame key={`${app.id}:${widget.id}`} app={app} title={widget.title} route={widget.route} query={{ surface: widget.id }} level={3} />
        ))}
      </div>
    </section>
  );
}
