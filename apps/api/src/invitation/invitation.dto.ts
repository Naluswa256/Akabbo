import { EventRole } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class CreateInvitationDto {
  @IsEnum(EventRole)
  role!: EventRole;

  @IsOptional()
  @IsString()
  @Matches(/^\+\d{7,15}$/, { message: 'invitedPhone must be E.164' })
  invitedPhone?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  maxUses?: number;

  @IsOptional()
  @IsInt()
  @Min(60)
  ttlSeconds?: number;
}

export class LinkPersonDto {
  @IsString()
  userId!: string;
}
