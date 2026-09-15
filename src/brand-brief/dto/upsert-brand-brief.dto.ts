import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpsertBrandBriefDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  tone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  approvedFacts?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  prohibitedClaims?: string;
}
