import { EventRole, EventStatus, FulfillmentKind, PaymentMethod, PledgeType } from '@prisma/client';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';

/** Money fields are integer minor units, transported as a digit string to
 *  avoid JS float/BigInt precision loss at the JSON boundary. */
const MONEY = /^\d+$/;

export class CreateEventDto {
  @IsString()
  @Length(1, 200)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string;

  /** Target contribution amount, integer minor units (§2: "25 million"). */
  @IsOptional()
  @Matches(MONEY, { message: 'targetAmount must be an integer (minor units)' })
  targetAmount?: string;

  @IsOptional()
  @IsDateString()
  eventDate?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  @Length(2, 2)
  country?: string;
}

export class UpdateEventDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @Matches(MONEY, { message: 'targetAmount must be an integer (minor units)' })
  targetAmount?: string;

  @IsOptional()
  @IsDateString()
  eventDate?: string;
}

export class SetEventStatusDto {
  @IsEnum(EventStatus)
  status!: EventStatus;
}

export class AddMemberDto {
  @IsString()
  userId!: string;

  @IsEnum(EventRole)
  role!: EventRole;
}

export class CreatePersonDto {
  @IsString()
  @Length(1, 200)
  displayName!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+\d{7,15}$/, { message: 'phone must be E.164' })
  phone?: string;
}

export class CreatePledgeDto {
  @IsString()
  personId!: string;

  @Matches(MONEY, { message: 'committedValue must be an integer (minor units)' })
  committedValue!: string;

  @IsOptional()
  @IsEnum(PledgeType)
  type?: PledgeType;
}

export class CorrectPledgeDto {
  @Matches(MONEY, { message: 'committedValue must be an integer (minor units)' })
  committedValue!: string;
}

export class CorrectFulfillmentDto {
  @Matches(MONEY, { message: 'value must be an integer (minor units)' })
  value!: string;
}

export class AddBudgetItemDto {
  @IsString()
  @Length(1, 200)
  name!: string;

  @Matches(MONEY, { message: 'targetValue must be an integer (minor units)' })
  targetValue!: string;
}

export class UpdateBudgetItemDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @IsOptional()
  @Matches(MONEY, { message: 'targetValue must be an integer (minor units)' })
  targetValue?: string;

  /** Per-line public visibility for PARTIALLY_PUBLIC budgets (transparency §16). */
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class AllocateDto {
  @IsString()
  fulfillmentId!: string;

  @IsString()
  budgetItemId!: string;

  @Matches(MONEY, { message: 'value must be an integer (minor units)' })
  value!: string;
}

export class RecordFulfillmentDto {
  @IsString()
  pledgeId!: string;

  @Matches(MONEY, { message: 'value must be an integer (minor units)' })
  value!: string;

  @IsOptional()
  @IsEnum(FulfillmentKind)
  kind?: FulfillmentKind;

  /** MTN / AIRTEL / CASH / BANK / OTHER / UNKNOWN (§14). */
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @IsOptional()
  @IsString()
  @Length(1, 1000)
  note?: string;

  /** Retry-safe key — the same key never books the money twice (§25, §42). */
  @IsOptional()
  @IsString()
  @Length(8, 200)
  idempotencyKey?: string;

  /** Record anyway after a suspected-duplicate warning. */
  @IsOptional()
  @IsBoolean()
  confirmDuplicate?: boolean;
}

/** A gift with no prior pledge (§15) — "Peter gave me 100k cash". */
export class RecordDirectContributionDto {
  @IsString()
  personId!: string;

  @Matches(MONEY, { message: 'value must be an integer (minor units)' })
  value!: string;

  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @IsOptional()
  @IsEnum(PledgeType)
  type?: PledgeType;

  @IsOptional()
  @IsString()
  @Length(1, 1000)
  note?: string;

  /** What an ITEM/SERVICE contribution actually is ("2 goats"). */
  @IsOptional()
  @IsString()
  @Length(1, 500)
  description?: string;

  @IsOptional()
  @IsString()
  @Length(8, 200)
  idempotencyKey?: string;
}
