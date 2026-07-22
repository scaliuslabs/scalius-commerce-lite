import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Check,
  Loader2,
  Pencil,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { MediaManager, type MediaFile } from "../media-manager";
import type { User } from "./AccountSettingsContainer";
import { useRouter } from "@tanstack/react-router";
import { getServerFnError } from "~/lib/api-helpers";
import { updateProfile } from "~/lib/api-functions/auth-management";
import { refreshAdminRouteContext } from "~/lib/admin-route-context";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { ADMIN_IMAGE_PRESETS } from "~/lib/admin-image-presentation";

function getInitials(nameStr: string): string {
  return nameStr
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

interface ProfileHeaderProps {
  user: User;
}

export function ProfileHeader({ user }: ProfileHeaderProps) {
  const router = useRouter();
  const currentUserIdRef = useRef(user.id);
  const isEditingRef = useRef(false);
  const [savedName, setSavedName] = useState(user.name);
  const [savedImage, setSavedImage] = useState(user.image || "");
  const [name, setName] = useState(user.name);
  const [image, setImage] = useState(user.image || "");
  const [isLoading, setIsLoading] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    isEditingRef.current = isEditing;
  }, [isEditing]);

  useEffect(() => {
    const nextSavedName = user.name;
    const nextSavedImage = user.image || "";
    const isDifferentUser = currentUserIdRef.current !== user.id;

    currentUserIdRef.current = user.id;
    setSavedName(nextSavedName);
    setSavedImage(nextSavedImage);

    if (isDifferentUser || !isEditingRef.current) {
      setName(nextSavedName);
      setImage(nextSavedImage);
      if (isDifferentUser) setIsEditing(false);
    }
  }, [user.id, user.name, user.image]);

  const normalizedName = name.trim();
  const hasChanges = normalizedName !== savedName || image !== savedImage;

  const handleImageSelect = (file: MediaFile) => {
    setImage(file.url);
    setIsEditing(true);
  };

  const removeImage = () => {
    setImage("");
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (normalizedName.length < 2) {
      toast.error("Name must be at least 2 characters");
      return;
    }

    setIsLoading(true);

    try {
      const result = await updateProfile({
        data: { name: normalizedName, image: image || null },
      });
      const updatedName = result.user?.name ?? normalizedName;
      const updatedImage =
        result.user?.image === undefined ? image || "" : result.user.image || "";

      toast.success("Profile saved");
      setSavedName(updatedName);
      setSavedImage(updatedImage);
      setName(updatedName);
      setImage(updatedImage);
      setIsEditing(false);
      void refreshAdminRouteContext(router);
    } catch (err) {
      toast.error(getServerFnError(err, "Failed to update profile"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    setName(savedName);
    setImage(savedImage);
    setIsEditing(false);
  };

  return (
    <Card className="max-w-4xl rounded-xl shadow-none">
      <CardHeader className="border-b p-4">
        <CardTitle className="flex items-center gap-2 text-base">
          <UserRound className="h-4 w-4" aria-hidden="true" />
          Profile
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4">
        <div className="grid gap-3 sm:grid-cols-[52px_minmax(0,1fr)] sm:items-center">
          <div className="relative h-12 w-12">
            <div className="h-12 w-12 overflow-hidden rounded-full border bg-muted">
              {image ? (
                <img
                  src={getOptimizedImageUrl(image, ADMIN_IMAGE_PRESETS.avatar)}
                  alt={name}
                  className="h-full w-full object-cover"
                  loading="lazy"
                  decoding="async"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-muted">
                  <span className="text-sm font-semibold text-foreground">
                    {getInitials(name)}
                  </span>
                </div>
              )}
            </div>
            {image && isEditing && (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                className="absolute -bottom-1 -right-1 h-11 w-11 rounded-full sm:h-8 sm:w-8"
                onClick={removeImage}
                title="Remove photo"
                aria-label="Remove profile photo"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>

          <div className="min-w-0 space-y-2.5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 flex-1 space-y-1.5">
                {isEditing ? (
                  <Input
                    id="profile-display-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !isLoading && hasChanges) {
                        event.preventDefault();
                        void handleSave();
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        handleCancel();
                      }
                    }}
                    className="min-h-11 max-w-xl text-base font-semibold sm:min-h-9"
                    placeholder="Display name"
                    aria-label="Display name"
                    autoFocus
                  />
                ) : (
                  <h2 className="truncate text-base font-semibold">{name}</h2>
                )}
                <p className="break-words text-sm text-muted-foreground">{user.email}</p>
              </div>

              <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 sm:min-h-9 sm:justify-end">
                <div
                  className="flex min-h-11 flex-wrap items-center gap-2 sm:min-h-9"
                  data-profile-edit-actions
                >
                  {!isEditing ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 sm:min-h-9"
                      onClick={() => setIsEditing(true)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit profile
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="min-h-11 sm:min-h-9"
                        onClick={handleCancel}
                        disabled={isLoading}
                      >
                        <X className="h-3.5 w-3.5" />
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        className="min-h-11 sm:min-h-9"
                        onClick={handleSave}
                        disabled={isLoading || !hasChanges}
                      >
                        {isLoading ? (
                          <Loader2 className="h-4 w-4 animate-spin mr-1" />
                        ) : (
                          <Check className="h-3.5 w-3.5" />
                        )}
                        Save profile
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="flex min-h-11 flex-wrap items-center gap-2 border-t pt-2.5 sm:min-h-9 sm:border-t-0 sm:pt-0">
              <MediaManager
                capability="image"
                onSelect={handleImageSelect}
                trigger={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="min-h-11 shrink-0 shadow-none after:shadow-none sm:min-h-9"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {image ? "Change photo" : "Add photo"}
                  </Button>
                }
              />
              {image && isEditing && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-11 text-destructive hover:text-destructive sm:min-h-9"
                  onClick={removeImage}
                  disabled={isLoading}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </Button>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
