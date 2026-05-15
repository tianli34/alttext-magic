import { AltCandidate, AltPlane, ImageUsageType, PresentStatus, AltDraftContextMode } from "@prisma/client";
import prisma from "../../db/prisma.server.js";

export class ContextBuilderService {
  /**
   * 按 §4.3.10 规则判定 context_mode 并构建传给 AI 的上下文快照
   */
  static async buildContext(candidate: Pick<AltCandidate, "altTargetId">): Promise<{ contextMode: AltDraftContextMode; contextSnapshot: Record<string, any> }> {
    const target = await prisma.altTarget.findUniqueOrThrow({
      where: { id: candidate.altTargetId },
    });

    const filename = this.extractFilename(target.previewUrl);

    // A. Collection / Article
    if (target.altPlane === AltPlane.COLLECTION_IMAGE_ALT || target.altPlane === AltPlane.ARTICLE_IMAGE_ALT) {
      return {
        contextMode: AltDraftContextMode.RESOURCE_SPECIFIC,
        contextSnapshot: {
          resourceType: target.altPlane === AltPlane.COLLECTION_IMAGE_ALT ? "COLLECTION" : "ARTICLE",
          resourceTitle: target.displayTitle,
          resourceHandle: target.displayHandle,
          filename,
        },
      };
    }

    // B. FILE_ALT
    const usages = await prisma.imageUsage.findMany({
      where: {
        altTargetId: target.id,
        presentStatus: PresentStatus.PRESENT,
      },
    });

    const usageCountPresent = usages.length;
    const usageTypesPresent = Array.from(new Set(usages.map(u => u.usageType)));
    
    const productUsages = usages.filter(u => u.usageType === ImageUsageType.PRODUCT);
    const fileUsages = usages.filter(u => u.usageType === ImageUsageType.FILE);

    // RESOURCE_SPECIFIC: 恰好1个PRODUCT usage，且无其他 present usage
    if (productUsages.length === 1 && fileUsages.length === 0) {
      return {
        contextMode: AltDraftContextMode.RESOURCE_SPECIFIC,
        contextSnapshot: {
          resourceType: "PRODUCT",
          resourceTitle: productUsages[0].title,
          resourceHandle: productUsages[0].handle,
          filename,
        },
      };
    }

    // FILE_NEUTRAL: 仅文件库 (无 PRODUCT usage)
    if (productUsages.length === 0) {
      return {
        contextMode: AltDraftContextMode.FILE_NEUTRAL,
        contextSnapshot: {
          filename,
        },
      };
    }

    // SHARED_NEUTRAL: 跨多个资源共享 (usageCountPresent >= 2)
    return {
      contextMode: AltDraftContextMode.SHARED_NEUTRAL,
      contextSnapshot: {
        usageCount: usageCountPresent,
        usageTypes: usageTypesPresent,
        filename,
      },
    };
  }

  private static extractFilename(url: string | null): string | undefined {
    if (!url) return undefined;
    try {
      const urlObj = new URL(url);
      const parts = urlObj.pathname.split("/");
      const last = parts[parts.length - 1];
      // strip query params just in case
      return last.split("?")[0];
    } catch {
      return undefined;
    }
  }
}
