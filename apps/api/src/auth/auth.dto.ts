import { IsEmail, IsString, Matches, Length } from 'class-validator';

export class StartOtpDto {
  /** E.164 phone number. */
  @IsString()
  @Matches(/^\+\d{7,15}$/, { message: 'phone must be E.164, e.g. +256700000000' })
  phone!: string;
}

export class StartEmailOtpDto {
  @IsEmail({}, { message: 'email must be a valid email address' })
  email!: string;
}

export class VerifyOtpDto {
  @IsString()
  challengeId!: string;

  @IsString()
  @Length(4, 8)
  code!: string;
}

export class RefreshTokenDto {
  @IsString()
  refreshToken!: string;
}
