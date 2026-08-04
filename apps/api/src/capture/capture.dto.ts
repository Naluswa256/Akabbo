import { PledgeType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';

const MONEY = /^\d+$/;

export class CaptureDto {
  @IsString()
  @Length(1, 2000)
  utterance!: string;
}

/** One turn to the AI operating interface (the conversational agent). */
export class AssistantDto {
  @IsString()
  @Length(1, 2000)
  message!: string;
}

/**
 * Partial edit of a still-PENDING confirmation's proposed action, before the
 * organizer confirms it — e.g. fixing an amount or item description a scan
 * misread. Every field is optional; only fields present in the request body
 * are changed. Not every intent supports every field (see
 * ConfirmationService.update's EDITABLE_FIELDS) — sending a field an intent
 * doesn't use is silently ignored, not an error, so the frontend doesn't
 * need to special-case which fields to send per card type.
 */
export class UpdatePendingDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  displayName?: string;

  @IsOptional()
  @Matches(MONEY, { message: 'amount must be an integer (minor units)' })
  amount?: string;

  @IsOptional()
  @IsEnum(PledgeType)
  type?: PledgeType;

  /** Pass an empty string to clear an existing description. */
  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;
}
