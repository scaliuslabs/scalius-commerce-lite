import { MediaManager } from "./MediaManager";

interface MediaFile {
  id: string;
  url: string;
  filename: string;
  size: number;
  createdAt: Date;
}

interface MediaPickerButtonProps {
  onSelect: (file: MediaFile) => void;
  selectedMedia?: {
    src: string;
    alt: string;
  } | null;
}

export function MediaPickerButton({
  onSelect,
  selectedMedia,
}: MediaPickerButtonProps) {
  const selectedFiles = selectedMedia
    ? [
        {
          id: "temp-id", // Placeholder ID
          url: selectedMedia.src,
          filename: selectedMedia.alt,
          size: 0,
          createdAt: new Date(),
        },
      ]
    : [];

  return (
    <div className="space-y-2">
      {selectedMedia && selectedMedia.src && (
        <div className="relative rounded-md border border-border p-1">
          <img
            src={selectedMedia.src}
            alt={selectedMedia.alt}
            className="h-40 w-full rounded object-contain"
          />
        </div>
      )}
      <MediaManager onSelect={onSelect} selectedFiles={selectedFiles} />
    </div>
  );
}
