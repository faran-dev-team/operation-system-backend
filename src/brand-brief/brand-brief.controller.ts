import { Body, Controller, Get, HttpCode, Put } from '@nestjs/common';

import type { AuthContext } from '../identity/auth-context';
import { CurrentAuth } from '../identity/current-auth.decorator';
import { BrandBriefService } from './brand-brief.service';
import { UpsertBrandBriefDto } from './dto/upsert-brand-brief.dto';

@Controller('brand-brief')
export class BrandBriefController {
  constructor(private readonly brandBriefService: BrandBriefService) {}

  @Get()
  get(@CurrentAuth() auth: AuthContext) {
    return this.brandBriefService.get(auth.workspace.id);
  }

  @Put()
  @HttpCode(200)
  upsert(@CurrentAuth() auth: AuthContext, @Body() body: UpsertBrandBriefDto) {
    return this.brandBriefService.upsert(auth.workspace.id, body);
  }
}
