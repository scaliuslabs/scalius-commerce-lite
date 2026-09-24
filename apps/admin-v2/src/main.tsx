import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/noto-sans-bengali/wght.css";
import "~/styles/global.css";
import { getRouter } from "./router";
import { beginBootSessionRead, endBootSessionRead } from "./lib/auth-guards";

const router = getRouter();

// Resolve the first route, including its session guard and any redirect,
// before anything renders: the blank index.html shell stays up until then,
// so protected content never flashes for a signed-out visitor.
beginBootSessionRead();
void router.load().finally(() => {
  endBootSessionRead();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
});
