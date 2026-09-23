import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { ImagePlus } from "lucide-react";
import { postApiV1AdminAuthUpdateProfile } from "@scalius/api-client/sdk";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useSaveBar, useServerFieldError } from "~/components/admin/shared/SaveBar";
import { apiData } from "~/lib/api";
import { refreshAdminRouteContext } from "~/lib/admin-route-context";
import { useMessages } from "~/i18n";
import { accountMessages } from "~/i18n/account";
import { MediaManager, type MediaFile } from "../media-manager";
import type { User } from "./AccountSettingsContainer";

function initials(name: string): string {
  return Array.from(name.trim().split(/\s+/), (part) => Array.from(part)[0] ?? "").join("").slice(0, 2).toUpperCase();
}

/** Profile card: photo, name and sign-in email. Edits go through the page's save bar. */
export function ProfileHeader({ user }: { user: User }) {
  const t = useMessages(accountMessages);
  const router = useRouter();
  const [saved, setSaved] = useState({ name: user.name, image: user.image || "" });
  const [name, setName] = useState(user.name);
  const [image, setImage] = useState(user.image || "");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  // Pressing Save with a short name reveals its message even before the field is left.
  const { revealed } = useServerFieldError("profile-name");

  const trimmed = name.trim();
  const hasChanges = trimmed !== saved.name || image !== saved.image;
  const nameTooShort = trimmed.length < 2;
  const nameInvalid = (touched || revealed) && nameTooShort;

  // A fresh route context (another tab, a refresh) updates the saved values;
  // it replaces the fields only when there is nothing unsaved in them.
  const userIdRef = useRef(user.id);
  const dirtyRef = useRef(hasChanges);
  dirtyRef.current = hasChanges;
  useEffect(() => {
    const next = { name: user.name, image: user.image || "" };
    setSaved(next);
    if (userIdRef.current !== user.id || !dirtyRef.current) {
      setName(next.name);
      setImage(next.image);
    }
    userIdRef.current = user.id;
  }, [user.id, user.name, user.image]);

  const discard = () => {
    setName(saved.name);
    setImage(saved.image);
    setTouched(false);
  };

  const save = async () => {
    setSaving(true);
    try {
      const result = await apiData(postApiV1AdminAuthUpdateProfile({ body: { name: trimmed, image: image || null } }));
      const next = {
        name: result.user?.name ?? trimmed,
        image: result.user?.image === undefined ? image : result.user.image || "",
      };
      setSaved(next);
      setName(next.name);
      setImage(next.image);
      setTouched(false);
      void refreshAdminRouteContext(router);
    } finally {
      setSaving(false);
    }
  };

  useSaveBar({ dirty: hasChanges, saving, invalid: nameTooShort, label: t("profile"), save, discard });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("profile")}</CardTitle>
      </CardHeader>
      <form
        method="post"
        action="/admin/account"
        noValidate
        // Saving happens from the save bar; Enter in the name field never submits.
        onSubmit={(event) => event.preventDefault()}
      >
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-body font-medium text-muted-foreground">
              {image ? <img src={mediaImageUrl(image, 160)} alt="" className="size-full object-cover" loading="lazy" decoding="async" /> : initials(trimmed || user.email)}
            </span>
            <MediaManager
              capability="image"
              onSelect={(file: MediaFile) => setImage(file.url)}
              trigger={
                <Button type="button" variant="outline" size="sm">
                  <ImagePlus aria-hidden="true" />
                  {t(image ? "changePhoto" : "addPhoto")}
                </Button>
              }
            />
            {image ? (
              <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setImage("")}>
                {t("removePhoto")}
              </Button>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="profile-name">{t("name")}</Label>
            <Input
              id="profile-name"
              value={name}
              autoComplete="name"
              maxLength={100}
              aria-invalid={nameInvalid || undefined}
              aria-describedby={nameInvalid ? "profile-name-error" : undefined}
              onBlur={() => setTouched(true)}
              onChange={(event) => setName(event.target.value)}
            />
            {nameInvalid ? <p id="profile-name-error" className="text-body text-destructive">{t("nameTooShort")}</p> : null}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-body font-medium">{t("email")}</span>
            <span className="break-words text-body text-muted-foreground">{user.email}</span>
          </div>
        </CardContent>
      </form>
    </Card>
  );
}
