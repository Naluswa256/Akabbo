import { AppConfigService } from '@akabbo/config';
import { PrismaService } from '@akabbo/prisma';
import { HeartbeatService } from './heartbeat.service';

describe('HeartbeatService (Phase 0 DoD: worker logs a heartbeat)', () => {
  const config = { workerHeartbeatMs: 15000 } as AppConfigService;

  function build(ping: jest.Mock): HeartbeatService {
    return new HeartbeatService(config, { ping } as unknown as PrismaService);
  }

  it('increments the tick count and pings the DB on each tick', async () => {
    const ping = jest.fn().mockResolvedValue(undefined);
    const svc = build(ping);

    await svc.tick();
    await svc.tick();

    expect(ping).toHaveBeenCalledTimes(2);
    expect(svc.tickCount).toBe(2);
  });

  it('does not throw when the DB is unreachable (degrades, next tick retries)', async () => {
    const ping = jest.fn().mockRejectedValue(new Error('connection refused'));
    const svc = build(ping);

    await expect(svc.tick()).resolves.toBeUndefined();
    expect(svc.tickCount).toBe(1);
  });

  it('starts and stops a timer across the module lifecycle', () => {
    jest.useFakeTimers();
    const ping = jest.fn().mockResolvedValue(undefined);
    const svc = build(ping);

    svc.onModuleInit();
    // Immediate tick fired on init.
    expect(ping).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(15000);
    expect(ping).toHaveBeenCalledTimes(2);

    svc.onModuleDestroy();
    jest.advanceTimersByTime(30000);
    // No further ticks after destroy.
    expect(ping).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });
});
