import { createRuntimeApiApp } from "./base-app";
import { partytownProxyRoutes } from "../routes/partytown-proxy";

const app = createRuntimeApiApp();
app.route("/__ptproxy", partytownProxyRoutes);

export default app;
