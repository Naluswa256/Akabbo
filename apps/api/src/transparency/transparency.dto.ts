import { BudgetVisibility, ContributorVisibility, PaymentMethod } from '@prisma/client';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

export class UpdatePublicSettingsDto {
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsEnum(ContributorVisibility)
  contributorVisibility?: ContributorVisibility;

  @IsOptional()
  @IsEnum(BudgetVisibility)
  budgetVisibility?: BudgetVisibility;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;
}

export class CreateAnnouncementDto {
  @IsString()
  @Length(1, 2000)
  body!: string;
}

export class CreatePaymentInstructionDto {
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsString()
  @Length(1, 100)
  label!: string;

  @IsString()
  @Length(1, 500)
  details!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

export class UpdatePaymentInstructionDto {
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  label?: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  details?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}
