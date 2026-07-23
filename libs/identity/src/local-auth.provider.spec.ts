import { UnauthorizedException } from '@nestjs/common';
import { LocalAuthProvider } from './local-auth.provider';

describe('LocalAuthProvider token refresh & auth hardening', () => {
  let provider: LocalAuthProvider;
  const mockPrisma: any = {
    user: {
      findUnique: jest.fn(),
    },
  };
  const mockUsers: any = {};
  const mockConfig: any = {
    get: jest.fn((key: string) => {
      if (key === 'JWT_SECRET') return 'test-secret-that-is-at-least-16-chars-long';
      if (key === 'JWT_TTL_SECONDS') return 3600;
      if (key === 'JWT_REFRESH_TTL_SECONDS') return 2592000;
      if (key === 'OTP_TTL_SECONDS') return 300;
      if (key === 'OTP_MAX_ATTEMPTS') return 5;
      return null;
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new LocalAuthProvider(mockPrisma, mockUsers, mockConfig);
  });

  it('issues both access and refresh tokens during session creation', async () => {
    // Access internal issueSession via verifyAccessToken + refreshToken
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-123', phoneVerified: true });

    // Force call refreshToken with a newly minted session
    // We can simulate session by calling refreshToken after getting session from issueSession
    const session = (provider as any).issueSession('user-123', true);

    expect(session.userId).toBe('user-123');
    expect(typeof session.accessToken).toBe('string');
    expect(typeof session.refreshToken).toBe('string');
    expect(session.accessToken).not.toEqual(session.refreshToken);
  });

  it('verifies valid access tokens and extracts actor', async () => {
    const session = (provider as any).issueSession('user-123', true);
    const actor = await provider.verifyAccessToken(session.accessToken);
    expect(actor).toEqual({ userId: 'user-123', phoneVerified: true });
  });

  it('rejects a refresh token when presented as an access token in verifyAccessToken', async () => {
    const session = (provider as any).issueSession('user-123', true);
    const actor = await provider.verifyAccessToken(session.refreshToken);
    expect(actor).toBeNull();
  });

  it('successfully refreshes session with a valid refresh token', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-123', phoneVerified: true });
    const session = (provider as any).issueSession('user-123', true);

    const newSession = await provider.refreshToken({ refreshToken: session.refreshToken });

    expect(newSession.userId).toBe('user-123');
    expect(typeof newSession.accessToken).toBe('string');
    expect(typeof newSession.refreshToken).toBe('string');
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({ where: { id: 'user-123' } });
  });

  it('rejects refreshing with an access token', async () => {
    const session = (provider as any).issueSession('user-123', true);

    await expect(provider.refreshToken({ refreshToken: session.accessToken })).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects refreshing with an invalid/tampered token', async () => {
    await expect(provider.refreshToken({ refreshToken: 'invalid.token.payload' })).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
