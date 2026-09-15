import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AdsModule } from './ads/ads.module';
import { BrandBriefModule } from './brand-brief/brand-brief.module';
import { ContentModule } from './content/content.module';
import { validateEnv } from './config/env';
import { EmailModule } from './email/email.module';
import { HealthModule } from './health/health.module';
import { IdentityModule } from './identity/identity.module';
import { InngestModule } from './inngest/inngest.module';
import { JobsModule } from './jobs/jobs.module';
import { MediaModule } from './media/media.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProvidersModule } from './providers/providers.module';
import { SocialModule } from './social/social.module';
import { SupabaseModule } from './supabase/supabase.module';
import { VoiceModule } from './voice/voice.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    PrismaModule,
    SupabaseModule,
    ProvidersModule,
    InngestModule,
    HealthModule,
    IdentityModule,
    WorkspacesModule,
    BrandBriefModule,
    ContentModule,
    MediaModule,
    SocialModule,
    AdsModule,
    EmailModule,
    VoiceModule,
    JobsModule,
  ],
})
export class AppModule {}
