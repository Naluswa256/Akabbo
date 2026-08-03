import { Body, Controller, Inject, Post } from '@nestjs/common';
import { AUTH_PROVIDER, AuthProvider, AuthSession } from '@akabbo/providers';
import { BillingService } from '@akabbo/billing';
import { StartOtpDto, StartEmailOtpDto, VerifyOtpDto, RefreshTokenDto } from './auth.dto';

type SessionResponse = {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
};

/**
 * Public auth endpoints (no guard). Phone-OTP or email-OTP → JWT session. The
 * controller is a thin edge over the AUTH_PROVIDER — no auth logic lives
 * here, except starting a genuinely new account's one-time free trial
 * (isNewUser), which deliberately lives here rather than in IdentityModule
 * (see identity.module.ts).
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
  async verifyOtp(@Body() dto: VerifyOtpDto): Promise<SessionResponse> {
    const session = await this.auth.verifyOtp({ challengeId: dto.challengeId, code: dto.code });
    await this.maybeStartTrial(session);
    return this.toSessionResponse(session);
  }

  @Post('email-otp/start')
  async startEmailOtp(@Body() dto: StartEmailOtpDto): Promise<{
    challengeId: string;
    expiresInSeconds: number;
    devCode?: string;
  }> {
    return this.auth.startEmailOtp({ email: dto.email });
  }

  @Post('email-otp/verify')
  async verifyEmailOtp(@Body() dto: VerifyOtpDto): Promise<SessionResponse> {
    const session = await this.auth.verifyEmailOtp({
      challengeId: dto.challengeId,
      code: dto.code,
    });
    await this.maybeStartTrial(session);
    return this.toSessionResponse(session);
  }

  @Post('refresh')
  async refresh(@Body() dto: RefreshTokenDto): Promise<SessionResponse> {
    const session = await this.auth.refreshToken({ refreshToken: dto.refreshToken });
    return this.toSessionResponse(session);
  }

  // The free trial belongs to the ACCOUNT, granted exactly once at genuine
  // signup — never again on a returning login, never per event, regardless
  // of which channel (phone or email) the account signed up through.
  private async maybeStartTrial(session: AuthSession): Promise<void> {
    if (!session.isNewUser) return;
    const account = await this.billing.ensureBillingAccount(session.userId);
    await this.billing.startAccountTrial(account.id);
  }

  private toSessionResponse(session: AuthSession): SessionResponse {
    return {
      userId: session.userId,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt.toISOString(),
    };
  }
}
