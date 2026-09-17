import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AuthContext } from '../identity/auth-context';
import { CurrentAuth } from '../identity/current-auth.decorator';
import { ContentService } from './content.service';
import { CreateContentRequestDto } from './dto/create-content-request.dto';

@Controller('content')
@UseGuards(RolesGuard)
export class ContentController {
  constructor(private readonly contentService: ContentService) {}

  @Post('requests')
  @HttpCode(200)
  @Roles('operator')
  submit(
    @CurrentAuth() auth: AuthContext,
    @Body() body: CreateContentRequestDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.contentService.submit(
      auth.workspace.id,
      auth.user.id,
      body,
      idempotencyKey,
    );
  }

  @Get('jobs/:id')
  getJob(@CurrentAuth() auth: AuthContext, @Param('id') id: string) {
    return this.contentService.getJob(auth.workspace.id, id);
  }

  @Get('drafts')
  listDrafts(@CurrentAuth() auth: AuthContext) {
    return this.contentService.listDrafts(auth.workspace.id);
  }

  @Get('drafts/:id')
  getDraft(@CurrentAuth() auth: AuthContext, @Param('id') id: string) {
    return this.contentService.getDraft(auth.workspace.id, id);
  }
}
