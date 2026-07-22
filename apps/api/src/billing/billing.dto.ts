import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

const PHONE = /^\+?\d{9,15}$/;

export class PurchaseEventPackDto {
  @IsString()
  @IsIn(['STARTER', 'STANDARD', 'PREMIUM'])
  planCode!: string;

  /** Payer's MoMo number (the wallet charged for our SaaS fee). */
  @Matches(PHONE, { message: 'phone must be a valid MoMo number' })
  phone!: string;

  @IsOptional()
  @IsIn(['mobile_money', 'card'])
  channel?: 'mobile_money' | 'card';
}

export class SubscribeDto {
  @IsString()
  @IsIn(['ORGANIZER_PRO', 'BUSINESS'])
  planCode!: string;

  @Matches(PHONE, { message: 'phone must be a valid MoMo number' })
  phone!: string;

  @IsOptional()
  @IsIn(['mobile_money', 'card'])
  channel?: 'mobile_money' | 'card';
}
