import { Module } from '@nestjs/common';

import { InngestModule } from '../inngest/inngest.module';
import { PrismaModule } from '../prisma/prisma.module';
import { DurableLeaseService } from './durable/durable-lease.service';
import { DurableRecoveryService } from './durable/durable-recovery.service';
import { DurableRetryService } from './durable/durable-retry.service';
import { JobsController } from './jobs.controller';

@Module({
  imports: [PrismaModule, InngestModule],
  controllers: [JobsController],
  providers: [
    DurableLeaseService,
    DurableRetryService,
    DurableRecoveryService,
  ],
  exports: [
    DurableLeaseService,
    DurableRetryService,
    DurableRecoveryService,
  ],
})
export class JobsModule {}
