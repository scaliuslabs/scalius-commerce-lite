import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import "~/styles/global.css";
import { getRouter } from "./router";

const router = getRouter();

// Resolve the first route, including its session guard and any redirect,
// before anything renders: the blank index.html shell stays up until then,
// so protected content never flashes for a signed-out visitor.
void router.load().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
});
