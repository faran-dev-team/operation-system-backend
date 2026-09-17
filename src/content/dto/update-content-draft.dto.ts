import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class UpdateContentDraftDto {
  @ApiProperty({
    description:
      'Replacement draft body. Must not be empty or whitespace-only.',
    example: 'Updated caption copy for the spring launch post.',
  })
  @IsString()
  @IsNotEmpty()
  content!: string;

  @ApiProperty({
    description:
      'The version the client last read. The update is rejected with 409 if the stored version has since changed.',
    example: 1,
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
