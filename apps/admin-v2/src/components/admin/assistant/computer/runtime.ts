import {
  createScaliusBrowserComputerAdapter,
  normalizeScaliusComputerRoute,
  ScaliusComputerController,
  type ScaliusComputerBinding,
  type ScaliusComputerRequest,
  type ScaliusComputerResult,
} from "@scalius/shared/assistant-computer";
import {
  canAccessAdminPath,
  type AdminAccessContext,
} from "~/lib/admin-access";
import { isKnownAdminComputerDestination } from "./navigation-authorization";

export interface AdminAssistantComputerRuntimeOptions {
  threadId: string;
  tabId: string;
  document?: Document;
  navigate?: (route: string) => void | Promise<void>;
  refresh?: () => void | Promise<void>;
  isActive?: () => boolean;
  access?: AdminAccessContext;
}

export interface AdminAssistantComputerRuntime {
  readonly binding: Readonly<ScaliusComputerBinding>;
  execute(request: ScaliusComputerRequest): Promise<ScaliusComputerResult>;
}

export function createAdminAssistantComputerRuntime(
  options: AdminAssistantComputerRuntimeOptions,
): AdminAssistantComputerRuntime {
  const pageDocument = resolveDocument(options.document);
  const pageWindow = pageDocument.defaultView;
  if (!pageWindow || !/^https?:$/.test(pageWindow.location.protocol)) {
    throw new Error("Admin computer requires an http(s) browser document");
  }
  const binding = Object.freeze<ScaliusComputerBinding>({
    surface: "admin",
    threadId: options.threadId,
    tabId: options.tabId,
  });
  const adapter = createScaliusBrowserComputerAdapter({
    document: pageDocument,
    origin: pageWindow.location.origin,
    currentRoute: () => currentRoute(pageWindow.location),
    goto: options.navigate ?? ((route) => pageWindow.location.assign(route)),
    refresh: options.refresh ?? (() => pageWindow.location.reload()),
    allowsRoute: (route) => isAllowedAdminComputerRoute(route, options.access),
    isActive: options.isActive ?? (() => pageDocument.visibilityState !== "hidden"),
    textMode: "headings",
    maxTargets: 60,
    maxTextNodes: 32,
  });
  const controller = new ScaliusComputerController({ binding, adapter });
  return {
    binding,
    execute: (request) => controller.execute(request),
  };
}

export function isAllowedAdminComputerRoute(
  route: string,
  access?: AdminAccessContext,
): boolean {
  const normalized = normalizeScaliusComputerRoute(route);
  if (!normalized) return false;
  const url = new URL(normalized, "https://admin.invalid");
  try {
    const pathname = decodeURIComponent(url.pathname);
    return isKnownAdminComputerDestination(pathname) &&
      (!access || canAccessAdminPath(pathname, access));
  } catch {
    return false;
  }
}

function resolveDocument(provided?: Document): Document {
  if (provided) return provided;
  if (typeof document === "undefined") {
    throw new Error("Admin computer requires a browser document");
  }
  return document;
}

function currentRoute(location: Location): string {
  return `${location.pathname}${location.search}${location.hash}`;
}
