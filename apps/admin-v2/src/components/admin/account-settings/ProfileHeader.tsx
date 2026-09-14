import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { MediaManager, type MediaFile } from "../media-manager";
import type { User } from "./AccountSettingsContainer";
import { useRouter } from "@tanstack/react-router";
import { getServerFnError } from "~/lib/api-helpers";
import { updateProfile } from "~/lib/api-functions/auth-management";
import { refreshAdminRouteContext } from "~/lib/admin-route-context";
import { getOptimizedImageUrl } from "@scalius/shared/image-optimizer";
import { ADMIN_IMAGE_PRESETS } from "~/lib/admin-image-presentation";
import {
  ContextualSaveBar,
  FieldError,
  InlineHelp,
  SettingsSection,
} from "~/components/admin/shell";

const NAME_ERROR = "Use at least 2 characters so colleagues can recognise you.";

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
  const hasChangesRef = useRef(false);
  const [savedName, setSavedName] = useState(user.name);
  const [savedImage, setSavedImage] = useState(user.image || "");
  const [name, setName] = useState(user.name);
  const [image, setImage] = useState(user.image || "");
  const [isLoading, setIsLoading] = useState(false);

  const normalizedName = name.trim();
  const hasChanges = normalizedName !== savedName || image !== savedImage;
  const nameError = normalizedName.length < 2 ? NAME_ERROR : null;

  useEffect(() => {
    hasChangesRef.current = hasChanges;
  }, [hasChanges]);

  useEffect(() => {
    const nextSavedName = user.name;
    const nextSavedImage = user.image || "";
    const isDifferentUser = currentUserIdRef.current !== user.id;

    currentUserIdRef.current = user.id;
    setSavedName(nextSavedName);
    setSavedImage(nextSavedImage);

    // A refresh of the signed-in user must not throw away an unsaved draft,
    // but switching accounts always resets the form to the new identity.
    if (isDifferentUser || !hasChangesRef.current) {
      setName(nextSavedName);
      setImage(nextSavedImage);
    }
  }, [user.id, user.name, user.image]);

  const handleImageSelect = (file: MediaFile) => {
    setImage(file.url);
  };

  const removeImage = () => {
    setImage("");
  };

  const handleSave = async () => {
    if (nameError) {
      toast.error(NAME_ERROR);
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
      void refreshAdminRouteContext(router);
    } catch (err) {
      toast.error(getServerFnError(err, "Failed to update profile"));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDiscard = () => {
    setName(savedName);
    setImage(savedImage);
  };

  return (
    <>
      <ContextualSaveBar
        isDirty={hasChanges}
        saving={isLoading}
        saveDisabled={Boolean(nameError)}
        saveDisabledReason="Fix the highlighted fields before saving."
        saveLabel="Save profile"
        allowSamePathNavigation
        stickyClassName="sticky top-15 z-30 lg:top-0"
        onDiscard={handleDiscard}
        onSave={() => void handleSave()}
      />

      <SettingsSection
        title="Profile"
        description="The name and photo other administrators see next to your activity."
      >
        <div className="grid gap-4 sm:grid-cols-[52px_minmax(0,1fr)] sm:items-start">
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
            {image && (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                className="absolute -bottom-1 -right-1 h-11 w-11 rounded-full sm:h-8 sm:w-8"
                onClick={removeImage}
                disabled={isLoading}
                title="Remove photo"
                aria-label="Remove profile photo"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>

          <div className="min-w-0 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="profile-display-name">Display name</Label>
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
                    handleDiscard();
                  }
                }}
                disabled={isLoading}
                aria-invalid={Boolean(nameError)}
                aria-describedby="profile-display-name-help"
                className="min-h-11 max-w-xl sm:min-h-9"
                placeholder="Display name"
                aria-label="Display name"
              />
              {nameError ? (
                <FieldError id="profile-display-name-help">{nameError}</FieldError>
              ) : (
                <InlineHelp id="profile-display-name-help">
                  Shown in the administrator list, audit entries, and shared work.
                </InlineHelp>
              )}
            </div>

            <div className="space-y-1.5">
              <p className="text-sm font-medium leading-none">Email</p>
              <p className="break-words text-sm text-muted-foreground">{user.email}</p>
              <InlineHelp>
                Changing the sign-in email needs a Super Admin; it is not editable here.
              </InlineHelp>
            </div>

            <div
              className="flex min-h-11 flex-wrap items-center gap-2 border-t pt-3 sm:min-h-9"
              data-profile-edit-actions
            >
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
              {image && (
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
      </SettingsSection>
    </>
  );
}
