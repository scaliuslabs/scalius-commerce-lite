import { useEffect, useState } from "react";

import {
  ADMIN_ASSISTANT_PAGE_STATE_EVENT,
  ADMIN_ASSISTANT_PAGE_STATE_GLOBAL,
  type AdminAssistantPageStateSnapshot,
} from "./page-state";

function readCurrentPageState(): AdminAssistantPageStateSnapshot | null {
  if (typeof window === "undefined") return null;
  return window[ADMIN_ASSISTANT_PAGE_STATE_GLOBAL] ?? null;
}

export function useAdminAssistantPageState(): AdminAssistantPageStateSnapshot | null {
  const [pageState, setPageState] = useState<AdminAssistantPageStateSnapshot | null>(
    readCurrentPageState,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handlePageState = (event: Event) => {
      const nextState = (event as CustomEvent<AdminAssistantPageStateSnapshot>)
        .detail;
      setPageState(nextState ?? readCurrentPageState());
    };

    setPageState(readCurrentPageState());
    window.addEventListener(ADMIN_ASSISTANT_PAGE_STATE_EVENT, handlePageState);
    return () => {
      window.removeEventListener(
        ADMIN_ASSISTANT_PAGE_STATE_EVENT,
        handlePageState,
      );
    };
  }, []);

  return pageState;
}
