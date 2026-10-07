// Opens an app provider's setup sheet on the page around it: from a button
// on that page (`useOpenAppProvider`), or from a link whose hash names the
// provider (`#app-provider=<plugin id>:<provider id>`: dashboard search, the
// app's "Where this app appears"). The sheet's code loads on first use, so a
// settings page that never opens one pays only for this host.
import { createContext, lazy, Suspense, useCallback, useContext, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { providerFromHash } from "./app-capabilities";

const AppProviderSheet = lazy(() => import("./AppProviderSheet").then((module) => ({ default: module.AppProviderSheet })));

const OpenProviderContext = createContext<((id: string) => void) | null>(null);

/** Opens a provider's sheet on this page; null outside a host (link to the capability page instead). */
export function useOpenAppProvider(): ((id: string) => void) | null {
  return useContext(OpenProviderContext);
}

export function AppProviderSheetHost({ children }: { children: ReactNode }) {
  const hash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate();
  const linked = providerFromHash(hash);
  const [opened, setOpened] = useState<string | null>(null);
  const id = opened ?? linked;
  // Mounted from the first opening on, so the sheet animates closed and keeps its state machine.
  const [used, setUsed] = useState(false);
  if (id && !used) setUsed(true);
  const open = useCallback((next: string) => setOpened(next), []);
  const close = () => {
    setOpened(null);
    // A linked sheet leaves the address as the page's own.
    if (linked) void navigate({ to: ".", search: true, replace: true });
  };
  return (
    <OpenProviderContext.Provider value={open}>
      {children}
      {used ? (
        <Suspense fallback={null}>
          <AppProviderSheet providerId={id} onClose={close} />
        </Suspense>
      ) : null}
    </OpenProviderContext.Provider>
  );
}
