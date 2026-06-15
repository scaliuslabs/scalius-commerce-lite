import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createMediaFolder,
  deleteMedia,
  deleteMediaFolder,
  moveMediaFiles,
  renameMediaFolder,
  updateMedia,
  type CreateMediaFolderInput,
  type MoveMediaFilesInput,
  type RenameMediaFolderInput,
  type UpdateMediaInput,
} from "../api-functions/media";
import { getServerFnError, queryKeys } from "./shared";

export function useDeleteMedia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => deleteMedia({ data: { fileId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.media.list() });
      queryClient.invalidateQueries({ queryKey: queryKeys.media.folders() });
      toast.success("File deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete file")),
  });
}

export function useUpdateMedia() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateMediaInput) => updateMedia({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.media.list() });
      toast.success("File updated");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to update file")),
  });
}

export function useMoveMediaFiles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: MoveMediaFilesInput) => moveMediaFiles({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.media.list() });
      queryClient.invalidateQueries({ queryKey: queryKeys.media.folders() });
      toast.success("Files moved");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to move files")),
  });
}

export function useCreateMediaFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateMediaFolderInput) => createMediaFolder({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.media.folders() });
      toast.success("Folder created");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to create folder")),
  });
}

export function useDeleteMediaFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (folderId: string) => deleteMediaFolder({ data: { folderId } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.media.folders() });
      queryClient.invalidateQueries({ queryKey: queryKeys.media.list() });
      toast.success("Folder deleted");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to delete folder")),
  });
}

export function useRenameMediaFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: RenameMediaFolderInput) => renameMediaFolder({ data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.media.folders() });
      toast.success("Folder renamed");
    },
    onError: (err) =>
      toast.error(getServerFnError(err, "Failed to rename folder")),
  });
}
