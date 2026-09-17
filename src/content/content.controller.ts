import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';

import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import type { AuthContext } from '../identity/auth-context';
import { CurrentAuth } from '../identity/current-auth.decorator';
import { ContentService } from './content.service';
import { CreateContentRequestDto } from './dto/create-content-request.dto';
import { UpdateContentDraftDto } from './dto/update-content-draft.dto';

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

  @Patch('drafts/:id')
  @Roles('operator')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Update a content draft with optimistic concurrency control',
    description:
      'Overwrites the draft body only if the stored version still equals ' +
      '`expectedVersion`, then increments the version atomically. Requires ' +
      'admin or operator; the workspace is always resolved from the ' +
      'authenticated session, never from the request.',
  })
  @ApiParam({ name: 'id', description: 'Content draft ID' })
  @ApiResponse({
    status: 200,
    description: 'Draft updated; returns the new version and body.',
  })
  @ApiResponse({
    status: 400,
    description:
      'content is empty, or expectedVersion is not a positive integer.',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid access token.' })
  @ApiResponse({
    status: 403,
    description: 'Authenticated user has the reviewer role.',
  })
  @ApiResponse({
    status: 404,
    description: "Draft does not exist in the caller's workspace.",
  })
  @ApiResponse({
    status: 409,
    description: 'expectedVersion no longer matches the stored version.',
  })
  updateDraft(
    @CurrentAuth() auth: AuthContext,
    @Param('id') id: string,
    @Body() body: UpdateContentDraftDto,
  ) {
    return this.contentService.updateDraftContent(
      auth.workspace.id,
      auth.user.id,
      id,
      body,
    );
  }
}
