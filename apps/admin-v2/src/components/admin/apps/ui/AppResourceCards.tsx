// Apps' cards on resource detail pages and their widgets on Home. A page asks
// only whether an app has one (the shell's cached surfaces read); the frames,
// their copy and the renderer load once there is something to draw, below
// the page's own content.
import { Suspense, lazy } from "react";
import { useAppCards, useAppWidgets, type AppTarget } from "./surfaces";

const AppCardList = lazy(() => import("./AppSurfaceFrame").then((module) => ({ default: module.AppCardList })));
const AppWidgetSection = lazy(() => import("./AppSurfaceFrame").then((module) => ({ default: module.AppWidgetSection })));

/**
 * Every app card declared for one resource, e.g. `<AppResourceCards target="order" id={order.id} />`.
 * Renders nothing (no wrapper either) without apps.view or when no app has a card for it.
 */
export function AppResourceCards({ target, id, inline = false, className = "space-y-4" }: {
  target: AppTarget;
  id: string;
  inline?: boolean;
  /** The wrapper's classes (its place in the page's grid). */
  className?: string;
}) {
  const cards = useAppCards(target);
  if (cards.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <AppCardList cards={cards} target={target} id={id} inline={inline} className={className} />
    </Suspense>
  );
}

/** Apps' widgets on Home; nothing when no app has one. */
export function AppHomeWidgets() {
  const widgets = useAppWidgets();
  if (widgets.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <AppWidgetSection widgets={widgets} />
    </Suspense>
  );
}
