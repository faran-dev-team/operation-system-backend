import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env';
import { isUsableSecret } from '../common/integration-status';
import { JobsModule } from '../jobs/jobs.module';
import { ContentController } from './content.controller';
import { ContentService } from './content.service';
import {
  CONTENT_GENERATION_EXECUTOR,
  DefaultContentGenerationExecutor,
} from './generation/content-generation.executor';
import { DeepSeekTextGenerationProvider } from './generation/deepseek-text-generation.provider';
import { StubTextGenerationProvider } from './generation/stub-text-generation.provider';
import {
  TEXT_GENERATION_PROVIDER,
  type TextGenerationProvider,
} from './generation/text-generation.types';

@Module({
  imports: [JobsModule],
  controllers: [ContentController],
  providers: [
    ContentService,
    StubTextGenerationProvider,
    DeepSeekTextGenerationProvider,
    DefaultContentGenerationExecutor,
    {
      provide: TEXT_GENERATION_PROVIDER,
      inject: [
        ConfigService,
        StubTextGenerationProvider,
        DeepSeekTextGenerationProvider,
      ],
      useFactory: (
        config: ConfigService<Env, true>,
        stub: StubTextGenerationProvider,
        deepseek: DeepSeekTextGenerationProvider,
      ): TextGenerationProvider => {
        const configured = config.get('CONTENT_GENERATION_PROVIDER', {
          infer: true,
        });
        const apiKey = config.get('DEEPSEEK_API_KEY', { infer: true });

        if (configured === 'stub') {
          return stub;
        }
        if (configured === 'deepseek') {
          return deepseek;
        }
        if (isUsableSecret(apiKey)) {
          return deepseek;
        }
        return stub;
      },
    },
    {
      provide: CONTENT_GENERATION_EXECUTOR,
      useExisting: DefaultContentGenerationExecutor,
    },
  ],
  exports: [ContentService],
})
export class ContentModule {}
