import {
  normalizeScaliusComputerRoute,
  parseScaliusComputerProgram,
} from "@scalius/shared/assistant-computer";

import { allNavSections } from "../../layout/AdminNav";

interface AdminNavigationDestination {
  labels: string[];
  path: string;
}

interface AdminTaskDestination {
  entity: RegExp;
  label: string;
  path: string;
}

const ADMIN_TASK_DESTINATIONS: readonly AdminTaskDestination[] = Object.freeze([
  { entity: /\bproducts?\b/iu, label: "New product", path: "/admin/products/new" },
  { entity: /\bcategor(?:y|ies)\b/iu, label: "New category", path: "/admin/categories/new" },
  { entity: /\bcollections?\b/iu, label: "New collection", path: "/admin/collections/new" },
  { entity: /\borders?\b/iu, label: "New order", path: "/admin/orders/new" },
  { entity: /\bcustomers?\b/iu, label: "New customer", path: "/admin/customers/new" },
  {
    entity: /\b(?:discounts?|promotions?)\b/iu,
    label: "New discount",
    path: "/admin/discounts/new",
  },
]);

const ADMIN_NAVIGATION_DESTINATIONS = buildAdminNavigationDestinations();

/** Single application-owned route catalog shared by the intent gate and the
 * browser runtime. Keeping the runtime on the sidebar-only subset would make
 * an authorized create task fail at the final browser boundary. */
export function isKnownAdminComputerDestination(pathname: string): boolean {
  return ADMIN_NAVIGATION_DESTINATIONS.has(pathname);
}

/**
 * `goto` is the one computer verb that can move the merchant without first
 * observing a visible control. Treat the signed tool output as authenticity,
 * not authority: the latest user turn must request this exact destination or
 * explicitly request the fixed create-task whose route is app-owned.
 */
export function isDirectAdminNavigationAuthorized(
  latestUserMessage: string | undefined,
  program: string,
): boolean {
  const parsed = parseScaliusComputerProgram(program);
  if (!parsed.ok) return false;
  const command = parsed.commands[0];
  if (!command || command.name !== "goto") return true;
  if (!latestUserMessage) return false;

  const route = normalizeScaliusComputerRoute(command.route);
  if (!route) return false;
  const url = new URL(route, "https://admin.invalid");
  if (url.search || url.hash) return false;

  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  const destination = ADMIN_NAVIGATION_DESTINATIONS.get(pathname);
  if (!destination || route !== destination.path) return false;

  return getAuthorizedAdminNavigationRoutes(latestUserMessage).includes(route);
}

/** Resolve app-owned routes from the latest direct navigation or explicit
 * create-task request. The same scope guards goto and visible-link clicks. */
export function getAuthorizedAdminNavigationRoutes(
  latestUserMessage: string | undefined,
): string[] {
  if (!latestUserMessage) return [];

  const requested = directAdminNavigationDestination(latestUserMessage);
  if (!requested) return explicitAdminTaskRoutes(latestUserMessage);
  if (/^(?:a|an|any|some)\b/iu.test(requested)) return [];
  const requestedTokens = canonicalDestinationTokens(requested);
  if (requestedTokens.length === 0) return [];

  const matchingRoutes = new Set<string>();
  for (const destination of ADMIN_NAVIGATION_DESTINATIONS.values()) {
    const matches = [
      destination.path.replace(/^\/admin\/?/u, ""),
      ...destination.labels,
    ]
      .map(canonicalDestinationTokens)
      .some(
        (candidate) =>
          candidate.length > 0 &&
          candidate.join("|") === requestedTokens.join("|"),
      );
    if (matches) matchingRoutes.add(destination.path);
  }
  return matchingRoutes.size === 1 ? [...matchingRoutes] : [];
}

function buildAdminNavigationDestinations(): Map<
  string,
  AdminNavigationDestination
> {
  const destinations = new Map<string, AdminNavigationDestination>();
  for (const section of allNavSections) {
    for (const item of section.items) {
      retainDestination(destinations, item.href, item.name);
      for (const subItem of item.subItems ?? []) {
        retainDestination(destinations, subItem.href, subItem.name);
      }
    }
  }
  for (const destination of ADMIN_TASK_DESTINATIONS) {
    retainDestination(destinations, destination.path, destination.label);
  }
  return destinations;
}

function explicitAdminTaskRoutes(message: string): string[] {
  if (!isExplicitCreateTaskRequest(message)) return [];
  const routes = ADMIN_TASK_DESTINATIONS
    .filter(({ entity }) => entity.test(message))
    .map(({ path }) => path);
  return [...new Set(routes)].slice(0, 4);
}

function isExplicitCreateTaskRequest(value: string): boolean {
  const message = value.trim();
  if (!message) return false;
  const action = "(?:create|add|make|build|set\\s+up)";
  return new RegExp(
    `^(?:please\\s+)?(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)?(?:help\\s+me\\s+)?${action}\\b`,
    "iu",
  ).test(message) || new RegExp(
    `^i\\s+(?:want|need|would\\s+like)\\s+you\\s+to\\s+${action}\\b`,
    "iu",
  ).test(message);
}

function retainDestination(
  destinations: Map<string, AdminNavigationDestination>,
  path: string,
  label: string,
): void {
  const current = destinations.get(path);
  if (current) {
    if (!current.labels.includes(label)) current.labels.push(label);
    return;
  }
  destinations.set(path, { path, labels: [label] });
}

function directAdminNavigationDestination(value: string): string | null {
  const message = value.trim();
  if (
    !message ||
    /[,;]/u.test(message) ||
    /\b(?:and|or|then|also|either|whichever|maybe|plus|with)\b/iu.test(message)
  ) {
    return null;
  }

  const command =
    "(?:open|navigate(?:\\s+me)?\\s+to|go\\s+to|visit|show\\s+me|take\\s+me\\s+to|send\\s+me\\s+to|jump\\s+to)";
  const patterns = [
    new RegExp(
      `^(?:please\\s+)?${command}\\s+(?:the\\s+)?(.+?)(?:\\s+(?:page|screen|section))?[?!.]*$`,
      "iu",
    ),
    new RegExp(
      `^(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?${command}\\s+(?:the\\s+)?(.+?)(?:\\s+(?:page|screen|section))?[?!.]*$`,
      "iu",
    ),
  ];
  for (const pattern of patterns) {
    const destination = pattern.exec(message)?.[1]?.trim();
    if (destination) return destination;
  }
  return null;
}

function canonicalDestinationTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .split(" ")
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length > 1 &&
        token !== "admin" &&
        token !== "page" &&
        token !== "screen" &&
        token !== "section",
    )
    .map(singularDestinationToken)
    .sort();
}

function singularDestinationToken(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (/(?:xes|sses|shes|ches|zes)$/u.test(token)) return token.slice(0, -2);
  return token.endsWith("s") && !token.endsWith("ss")
    ? token.slice(0, -1)
    : token;
}
