import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import { AppConfigService } from '@akabbo/config';
import { PrismaService } from '@akabbo/prisma';
import {
  AuthenticatedActor,
  AuthProvider,
  AuthSession,
  RefreshTokenRequest,
  SMS_PROVIDER,
  SmsProvider,
  StartOtpRequest,
  StartOtpResult,
  VerifyOtpRequest,
} from '@akabbo/providers';
import { UserService } from './user.service';
import { generateOtp, hashOtp, verifyOtp } from './otp.util';

interface AccessJwtPayload {
  sub: string;
  pv: boolean;
  type?: 'access';
}

interface RefreshJwtPayload {
  sub: string;
  pv: boolean;
  type: 'refresh';
}

/**
 * Phone-OTP + JWT auth (Phase 1), implementing the {@link AuthProvider}
 * interface. Dispatches OTP via {@link SmsProvider} when available.
 */
@Injectable()
export class LocalAuthProvider implements AuthProvider {
  private readonly logger = new Logger(LocalAuthProvider.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UserService,
    private readonly config: AppConfigService,
    @Optional() @Inject(SMS_PROVIDER) private readonly sms?: SmsProvider,
  ) {}

  async startOtp(request: StartOtpRequest): Promise<StartOtpResult> {
    const ttl = this.config.get('OTP_TTL_SECONDS');
    const code = generateOtp(6);
    const challenge = await this.prisma.authOtpChallenge.create({
      data: {
        phone: request.phone,
        codeHash: hashOtp(code),
        expiresAt: new Date(Date.now() + ttl * 1000),
      },
      select: { id: true },
    });

    this.logger.log(`OTP challenge issued (challengeId=${challenge.id})`);

    // Dispatch OTP via SMS provider (e.g. UGSMS) if configured
    if (this.sms) {
      this.sms
        .send({
          to: request.phone,
          body: `Your Akabbo verification code is: ${code}. Valid for 5 minutes.`,
          idempotencyKey: `otp:${challenge.id}`,
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`OTP SMS dispatch skipped/failed for ${request.phone}: ${msg}`);
        });
    }

    return {
      challengeId: challenge.id,
      expiresInSeconds: ttl,
      devCode: this.config.get('AUTH_EXPOSE_OTP') ? code : undefined,
    };
  }

  async verifyOtp(request: VerifyOtpRequest): Promise<AuthSession> {
    const challenge = await this.prisma.authOtpChallenge.findUnique({
      where: { id: request.challengeId },
    });
    if (!challenge) throw new BadRequestException('Invalid or expired challenge');
    if (challenge.consumedAt) throw new BadRequestException('Challenge already used');
    if (challenge.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Challenge expired');
    }
    if (challenge.attempts >= this.config.get('OTP_MAX_ATTEMPTS')) {
      throw new BadRequestException('Too many attempts');
    }

    if (!verifyOtp(request.code, challenge.codeHash)) {
      await this.prisma.authOtpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Incorrect code');
    }

    // Consume the challenge (single-use) and establish the verified user.
    await this.prisma.authOtpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
    const user = await this.users.findOrCreateByPhone(challenge.phone);
    if (!user.phoneVerified) await this.users.markPhoneVerified(user.id);

    return this.issueSession(user.id, true);
  }

  async refreshToken(request: RefreshTokenRequest): Promise<AuthSession> {
    const secret = this.config.get('JWT_SECRET');
    let payload: RefreshJwtPayload;
    try {
      payload = jwt.verify(request.refreshToken, secret) as RefreshJwtPayload;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    if (payload.type !== 'refresh') {
      throw new UnauthorizedException('Invalid token type for refresh');
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    return this.issueSession(user.id, user.phoneVerified);
  }

  verifyAccessToken(token: string): Promise<AuthenticatedActor | null> {
    try {
      const payload = jwt.verify(token, this.config.get('JWT_SECRET')) as AccessJwtPayload;
      if (payload.type && payload.type !== 'access') {
        return Promise.resolve(null);
      }
      return Promise.resolve({ userId: payload.sub, phoneVerified: payload.pv });
    } catch {
      // Invalid/expired token → unauthenticated (never a trusted default).
      return Promise.resolve(null);
    }
  }

  private issueSession(userId: string, phoneVerified: boolean): AuthSession {
    const ttl = this.config.get('JWT_TTL_SECONDS');
    const refreshTtl = this.config.get('JWT_REFRESH_TTL_SECONDS');
    const secret = this.config.get('JWT_SECRET');

    const accessPayload: AccessJwtPayload = { sub: userId, pv: phoneVerified, type: 'access' };
    const accessToken = jwt.sign(accessPayload, secret, { expiresIn: ttl });

    const refreshPayload: RefreshJwtPayload = { sub: userId, pv: phoneVerified, type: 'refresh' };
    const refreshToken = jwt.sign(refreshPayload, secret, { expiresIn: refreshTtl });

    return {
      userId,
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + ttl * 1000),
    };
  }
}
