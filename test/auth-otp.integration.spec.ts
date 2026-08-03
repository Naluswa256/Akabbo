import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { IdentityModule, UserService } from '@akabbo/identity';
import { AUTH_PROVIDER, AuthProvider } from '@akabbo/providers';

/**
 * Phone-OTP and email-OTP auth (Phase 1 + email extension) — the actual
 * challenge/verify flow through LocalAuthProvider. Previously untested at
 * this level (only JWT-issuing internals had unit coverage); this spec is
 * the first real coverage of startOtp/verifyOtp, and the primary coverage
 * for the new email channel and the channel guard/cooldown that ship with it.
 */
describe('Auth OTP — phone + email (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let auth: AuthProvider;
  let users: UserService;

  let seq = 0;
  const uniquePhone = (): string => `+256701${String(seq++).padStart(6, '0')}`;
  const uniqueEmail = (): string => `otp-test-${seq++}@example.com`;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, PrismaModule, IdentityModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    auth = moduleRef.get(AUTH_PROVIDER);
    users = moduleRef.get(UserService);
    await prisma.$connect();
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE auth_otp_challenge, "user" RESTART IDENTITY CASCADE');
  });

  const wrongCodeFor = (devCode: string): string => (devCode === '000000' ? '111111' : '000000');

  it('phone: start → verify creates a new, phone-verified user on first signup', async () => {
    const phone = uniquePhone();
    const started = await auth.startOtp({ phone });
    expect(started.devCode).toMatch(/^\d{6}$/);

    const session = await auth.verifyOtp({
      challengeId: started.challengeId,
      code: started.devCode!,
    });
    expect(session.isNewUser).toBe(true);
    expect(typeof session.accessToken).toBe('string');

    const user = await users.getById(session.userId);
    expect(user?.phone).toBe(phone);
    expect(user?.phoneVerified).toBe(true);
    expect(user?.email).toBeNull();
  });

  it('phone: a returning number is found, not recreated, and isNewUser is false', async () => {
    const phone = uniquePhone();
    const first = await auth.startOtp({ phone });
    const firstSession = await auth.verifyOtp({
      challengeId: first.challengeId,
      code: first.devCode!,
    });

    const second = await auth.startOtp({ phone });
    const secondSession = await auth.verifyOtp({
      challengeId: second.challengeId,
      code: second.devCode!,
    });

    expect(secondSession.isNewUser).toBe(false);
    expect(secondSession.userId).toBe(firstSession.userId);
  });

  it('email: start → verify creates a new, email-verified user on first signup', async () => {
    const email = uniqueEmail();
    const started = await auth.startEmailOtp({ email });
    expect(started.devCode).toMatch(/^\d{6}$/);

    const session = await auth.verifyEmailOtp({
      challengeId: started.challengeId,
      code: started.devCode!,
    });
    expect(session.isNewUser).toBe(true);

    const user = await users.getById(session.userId);
    expect(user?.email).toBe(email);
    expect(user?.emailVerified).toBe(true);
    expect(user?.phone).toBeNull();
  });

  it('email: a returning address is found, not recreated, and isNewUser is false', async () => {
    const email = uniqueEmail();
    const first = await auth.startEmailOtp({ email });
    const firstSession = await auth.verifyEmailOtp({
      challengeId: first.challengeId,
      code: first.devCode!,
    });

    const second = await auth.startEmailOtp({ email });
    const secondSession = await auth.verifyEmailOtp({
      challengeId: second.challengeId,
      code: second.devCode!,
    });

    expect(secondSession.isNewUser).toBe(false);
    expect(secondSession.userId).toBe(firstSession.userId);
  });

  it('channel guard: a phone challenge cannot be verified via the email endpoint', async () => {
    const started = await auth.startOtp({ phone: uniquePhone() });
    await expect(
      auth.verifyEmailOtp({ challengeId: started.challengeId, code: started.devCode! }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('channel guard: an email challenge cannot be verified via the phone endpoint', async () => {
    const started = await auth.startEmailOtp({ email: uniqueEmail() });
    await expect(
      auth.verifyOtp({ challengeId: started.challengeId, code: started.devCode! }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a challenge is single-use: verifying twice rejects the second attempt', async () => {
    const started = await auth.startOtp({ phone: uniquePhone() });
    await auth.verifyOtp({ challengeId: started.challengeId, code: started.devCode! });
    await expect(
      auth.verifyOtp({ challengeId: started.challengeId, code: started.devCode! }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an incorrect code is rejected and repeated failures lock the challenge out', async () => {
    const started = await auth.startOtp({ phone: uniquePhone() });
    const wrong = wrongCodeFor(started.devCode!);

    for (let i = 0; i < 5; i++) {
      await expect(
        auth.verifyOtp({ challengeId: started.challengeId, code: wrong }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
    // OTP_MAX_ATTEMPTS (default 5) now exhausted — even the correct code is refused.
    await expect(
      auth.verifyOtp({ challengeId: started.challengeId, code: started.devCode! }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cooldown: a second start for the same phone number within the window is rejected', async () => {
    const phone = uniquePhone();
    await auth.startOtp({ phone });
    await expect(auth.startOtp({ phone })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cooldown: a second start for the same email within the window is rejected', async () => {
    const email = uniqueEmail();
    await auth.startEmailOtp({ email });
    await expect(auth.startEmailOtp({ email })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cooldown: a fresh start is allowed again once the cooldown window has elapsed', async () => {
    const phone = uniquePhone();
    const first = await auth.startOtp({ phone });
    // Backdate the issued challenge past OTP_COOLDOWN_SECONDS instead of
    // sleeping in the test.
    await prisma.authOtpChallenge.update({
      where: { id: first.challengeId },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    await expect(auth.startOtp({ phone })).resolves.toMatchObject({
      challengeId: expect.any(String),
    });
  });

  it('cooldown is per-identifier: starting for a different phone is unaffected', async () => {
    await auth.startOtp({ phone: uniquePhone() });
    await expect(auth.startOtp({ phone: uniquePhone() })).resolves.toMatchObject({
      challengeId: expect.any(String),
    });
  });
});
