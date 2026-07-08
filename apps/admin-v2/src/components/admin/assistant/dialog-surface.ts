import { useEffect } from "react";

import {
  registerAdminAssistantSurface,
  sanitizeAdminAssistantText,
  type AdminAssistantSurfaceHandle,
  type AdminAssistantSurfaceRegistration,
} from "./page-state";

const MAX_DIALOG_ID_LENGTH = 80;

export interface AdminAssistantDialogSurfaceRegistrationInput {
  id: string;
  label: string;
  open: boolean;
  submitting?: boolean;
  dirty?: boolean;
  validationErrorCount?: number;
}

export interface AdminAssistantDialogSurfaceHandle {
  update: (input: AdminAssistantDialogSurfaceRegistrationInput) => void;
  unregister: () => void;
}

type AdminAssistantDialogSurfaceRegistration =
  AdminAssistantSurfaceRegistration & {
    kind: "dialog";
  };

export function createAdminAssistantDialogSurfaceRegistration(
  input: AdminAssistantDialogSurfaceRegistrationInput,
): AdminAssistantDialogSurfaceRegistration {
  const dialogId =
    sanitizeAdminAssistantText(input.id, MAX_DIALOG_ID_LENGTH) ??
    "assistant-dialog";
  const label =
    sanitizeAdminAssistantText(input.label) ?? "Visible admin dialog";

  return {
    id: dialogId,
    kind: "dialog",
    label,
    visible: input.open === true,
    open: input.open === true,
    dirty: input.dirty,
    submitting: input.submitting,
    validationErrorCount: input.validationErrorCount,
  };
}

export function registerAdminAssistantDialogSurface(
  input: AdminAssistantDialogSurfaceRegistrationInput,
): AdminAssistantDialogSurfaceHandle {
  let current = createAdminAssistantDialogSurfaceRegistration(input);
  const surfaceHandle: AdminAssistantSurfaceHandle =
    registerAdminAssistantSurface(current);

  return {
    update: (nextInput) => {
      current = createAdminAssistantDialogSurfaceRegistration(nextInput);
      surfaceHandle.update(current);
    },
    unregister: () => surfaceHandle.unregister(),
  };
}

export function useAdminAssistantDialogSurface(
  input: AdminAssistantDialogSurfaceRegistrationInput & { enabled?: boolean },
): void {
  const {
    dirty,
    enabled,
    id,
    label,
    open,
    submitting,
    validationErrorCount,
  } = input;

  useEffect(() => {
    if (enabled === false) return undefined;

    const handle = registerAdminAssistantDialogSurface({
      dirty,
      id,
      label,
      open,
      submitting,
      validationErrorCount,
    });
    return () => handle.unregister();
  }, [
    dirty,
    enabled,
    id,
    label,
    open,
    submitting,
    validationErrorCount,
  ]);
}
