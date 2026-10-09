import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/noto-sans-bengali/wght.css";
import "~/styles/global.css";
import { getRouter } from "./router";
import { beginBootSessionRead, endBootSessionRead } from "./lib/auth-guards";

const router = getRouter();

// The first load answers every guard, including a redirect to sign-in, from
// the session read index.html started. Nothing protected renders before that
// read: the router commits a page only once its guards have passed (and then
// either its data or, after `defaultPendingMs`, its skeleton inside the
// shell); until then the boot spinner stays.
beginBootSessionRead();
const stop = router.subscribe("onResolved", () => {
  stop();
  endBootSessionRead();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
