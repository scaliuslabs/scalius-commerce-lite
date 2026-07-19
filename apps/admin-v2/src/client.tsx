import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
    </StrictMode>,
    {
      onRecoverableError(error, errorInfo) {
        console.error(
          "Recoverable React render error",
          error,
          errorInfo.componentStack,
        );
      },
    },
  );
});
