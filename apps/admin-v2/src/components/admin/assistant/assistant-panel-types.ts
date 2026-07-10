export type AdminAssistantStatus =
  | { kind: "idle"; message: string }
  | { kind: "success"; message: string }
  | { kind: "disabled"; message: string }
  | { kind: "error"; message: string };
