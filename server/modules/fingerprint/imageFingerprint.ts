import { createHash } from "node:crypto";

export interface MediaImageInput {
  id: string;
  alt: string | null;
  imageUrl: string | null;
}

export interface CollectionImageInput {
  url: string;
  altText: string | null;
}

export function computeProductFingerprint(mediaImages: MediaImageInput[]): string {
  const fingerprint = [...mediaImages]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => `${m.id}|${m.alt ?? ""}|${m.imageUrl ?? ""}`)
    .join("||");

  return createHash("sha256").update(fingerprint, "utf8").digest("hex");
}

export function computeCollectionFingerprint(
  image: CollectionImageInput | null,
): string {
  if (image === null) {
    return createHash("sha256").update("", "utf8").digest("hex");
  }

  const fingerprint = `${image.url}|${image.altText ?? ""}`;
  return createHash("sha256").update(fingerprint, "utf8").digest("hex");
}
