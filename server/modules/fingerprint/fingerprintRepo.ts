import { ResourceImageFingerprintResourceType } from "@prisma/client";
import prisma from "../../db/prisma.server";

export type { ResourceImageFingerprintResourceType };

export async function get(
  shopId: string,
  resourceType: ResourceImageFingerprintResourceType,
  resourceId: string,
): Promise<string | null> {
  const row = await prisma.resourceImageFingerprint.findUnique({
    where: {
      shopId_resourceType_resourceId: {
        shopId,
        resourceType,
        resourceId,
      },
    },
    select: { fingerprintHash: true },
  });
  return row?.fingerprintHash ?? null;
}

export async function upsert(
  shopId: string,
  resourceType: ResourceImageFingerprintResourceType,
  resourceId: string,
  fingerprint: string,
): Promise<void> {
  await prisma.resourceImageFingerprint.upsert({
    where: {
      shopId_resourceType_resourceId: {
        shopId,
        resourceType,
        resourceId,
      },
    },
    create: {
      shopId,
      resourceType,
      resourceId,
      fingerprintHash: fingerprint,
    },
    update: {
      fingerprintHash: fingerprint,
    },
  });
}

export async function compareAndDecide(
  shopId: string,
  resourceType: ResourceImageFingerprintResourceType,
  resourceId: string,
  newFingerprint: string,
): Promise<"CHANGED" | "UNCHANGED"> {
  const stored = await get(shopId, resourceType, resourceId);
  if (stored === null) {
    return "CHANGED";
  }
  return stored === newFingerprint ? "UNCHANGED" : "CHANGED";
}
