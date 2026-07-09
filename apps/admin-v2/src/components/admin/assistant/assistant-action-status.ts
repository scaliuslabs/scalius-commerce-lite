import type {
  AdminAssistantChatAction,
} from "../../../lib/api-functions/ai";
import type { AdminAssistantPageActionExecutionResult } from "./page-actions";
import type { AdminAssistantStatus } from "./assistant-panel-types";

export function getAdminAssistantPageActionStatus(
  action: Exclude<AdminAssistantChatAction, { type: "navigate" }>,
  result: AdminAssistantPageActionExecutionResult,
): AdminAssistantStatus {
  if (result.ok) {
    if (action.type === "save_registered_form") {
      return { kind: "success", message: "Visible form saved successfully." };
    }
    if (action.type === "select_visible_rows") {
      return { kind: "success", message: "Visible rows selected." };
    }
    if (action.type === "clear_selection") {
      return { kind: "success", message: "Selection cleared." };
    }
    if (action.type === "focus_surface") {
      return { kind: "success", message: "Visible field focused." };
    }
    return {
      kind: "success",
      message: "Draft applied to the visible form. Review it before saving.",
    };
  }

  if (result.reason === "already_consumed") {
    return {
      kind: "error",
      message: "That action has already been used. Nothing was repeated.",
    };
  }

  if (
    result.reason === "handler_unavailable" ||
    result.reason === "invalid_action"
  ) {
    return {
      kind: "error",
      message:
        "That action expired because the visible page changed. Nothing was changed.",
    };
  }

  if (action.type === "save_registered_form") {
    return {
      kind: "error",
      message:
        "The visible form was not saved. Review the page error, then request a new save action.",
    };
  }

  return {
    kind: "error",
    message: "The page action failed. Review the visible page before trying again.",
  };
}
