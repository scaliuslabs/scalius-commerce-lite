import { OfflineBanner } from "./OfflineBanner";
import { useOfflineNavigation } from "./offline-navigation";

/**
 * The shell's offline behaviour in one lazily loaded piece: the navigation
 * guard (a page whose code is not in the tab waits for the connection) and
 * the banner under the top bar. The first paint never waits for it.
 */
export default function OfflineShell() {
  const { online, waiting } = useOfflineNavigation();
  return online ? null : <OfflineBanner waiting={waiting} />;
}
