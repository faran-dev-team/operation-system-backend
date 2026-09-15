import { Injectable, NotFoundException } from '@nestjs/common';
import type { BrandBrief } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { UpsertBrandBriefDto } from './dto/upsert-brand-brief.dto';

@Injectable()
export class BrandBriefService {
  constructor(private readonly prisma: PrismaService) {}

  async get(workspaceId: string) {
    const brief = await this.prisma.db.brandBrief.findUnique({
      where: { workspaceId },
    });
    if (!brief) {
      throw new NotFoundException(
        'Brand brief was not found for this workspace.',
      );
    }
    return this.serialize(brief);
  }

  async upsert(workspaceId: string, dto: UpsertBrandBriefDto) {
    const brief = await this.prisma.db.brandBrief.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        name: dto.name.trim(),
        tone: dto.tone?.trim() || null,
        approvedFacts: dto.approvedFacts?.trim() || null,
        prohibitedClaims: dto.prohibitedClaims?.trim() || null,
      },
      update: {
        name: dto.name.trim(),
        tone: dto.tone?.trim() || null,
        approvedFacts: dto.approvedFacts?.trim() || null,
        prohibitedClaims: dto.prohibitedClaims?.trim() || null,
      },
    });

    return this.serialize(brief);
  }

  private serialize(brief: BrandBrief) {
    return {
      id: brief.id,
      workspaceId: brief.workspaceId,
      name: brief.name,
      tone: brief.tone,
      approvedFacts: brief.approvedFacts,
      prohibitedClaims: brief.prohibitedClaims,
      createdAt: brief.createdAt,
      updatedAt: brief.updatedAt,
    };
  }
}
