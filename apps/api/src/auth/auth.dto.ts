import { IsString, Matches, Length } from 'class-validator';

export class StartOtpDto {
  /** E.164 phone number. */
  @IsString()
  @Matches(/^\+\d{7,15}$/, { message: 'phone must be E.164, e.g. +256700000000' })
  phone!: string;
}

export class VerifyOtpDto {
  @IsString()
  challengeId!: string;

  @IsString()
  @Length(4, 8)
  code!: string;
}
