import { Body, Controller, Inject, Post } from '@nestjs/common';
import { AUTH_PROVIDER, AuthProvider } from '@akabbo/providers';
import { BillingService } from '@akabbo/billing';
import { StartOtpDto, VerifyOtpDto, RefreshTokenDto } from './auth.dto';

/**
 * Public auth endpoints (no guard). Phone-OTP → JWT session. The controller is
 * a thin edge over the AUTH_PROVIDER — no auth logic lives here, except
 * starting a genuinely new account's one-time free trial (isNewUser), which
 * deliberately lives here rather than in IdentityModule (see identity.module.ts).
 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    private readonly billing: BillingService,
  ) {}

  @Post('otp/start')
  async startOtp(@Body() dto: StartOtpDto): Promise<{
    challengeId: string;
    expiresInSeconds: number;
    devCode?: string;
  }> {
    return this.auth.startOtp({ phone: dto.phone });
  }

  @Post('otp/verify')
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
  ): Promise<{ userId: string; accessToken: string; refreshToken: string; expiresAt: string }> {
    const session = await this.auth.verifyOtp({ challengeId: dto.challengeId, code: dto.code });
    // The free trial belongs to the ACCOUNT, granted exactly once at genuine
    // signup — never again on a returning login, never per event.
    if (session.isNewUser) {
      const account = await this.billing.ensureBillingAccount(session.userId);
      await this.billing.startAccountTrial(account.id);
    }
    return {
      userId: session.userId,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  @Post('refresh')
  async refresh(
    @Body() dto: RefreshTokenDto,
  ): Promise<{ userId: string; accessToken: string; refreshToken: string; expiresAt: string }> {
    const session = await this.auth.refreshToken({ refreshToken: dto.refreshToken });
    return {
      userId: session.userId,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt.toISOString(),
    };
  }
}
