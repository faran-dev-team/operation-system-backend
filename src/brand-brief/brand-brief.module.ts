import { Module } from '@nestjs/common';

import { BrandBriefController } from './brand-brief.controller';
import { BrandBriefService } from './brand-brief.service';

@Module({
  controllers: [BrandBriefController],
  providers: [BrandBriefService],
  exports: [BrandBriefService],
})
export class BrandBriefModule {}
