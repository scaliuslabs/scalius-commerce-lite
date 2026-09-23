import { MediaWorkspace } from "./MediaWorkspace";
import { useMediaManager } from "./hooks/useMediaManager";
import type {
  MediaWorkspaceRouteState,
  MediaWorkspaceRouteUpdateOptions,
} from "./types";

interface MediaManagerPageProps {
  workspaceState: MediaWorkspaceRouteState;
  onWorkspaceStateChange: (
    updates: Partial<MediaWorkspaceRouteState>,
    options?: MediaWorkspaceRouteUpdateOptions,
  ) => void;
}

/** The Files page. Render errors fall through to the route's error screen. */
export function MediaManagerPage({
  workspaceState,
  onWorkspaceStateChange,
}: MediaManagerPageProps) {
  const manager = useMediaManager({
    autoLoad: true,
    capability: "both",
    workspaceState,
    onWorkspaceStateChange,
  });
  return <MediaWorkspace manager={manager} capability="both" />;
}
