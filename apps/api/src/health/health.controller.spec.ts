import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import request from 'supertest';
import { PrismaService } from '@akabbo/prisma';
import { HealthController } from './health.controller';
import { PrismaHealthIndicator } from './prisma.health';

describe('HealthController (Phase 0 DoD: health check passes)', () => {
  let app: INestApplication;
  const prismaPing = jest.fn();

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TerminusModule],
      controllers: [HealthController],
      providers: [
        PrismaHealthIndicator,
        { provide: PrismaService, useValue: { ping: prismaPing } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await app.close();
  });

  it('GET /health returns ok (liveness, no DB needed)', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /health/ready returns ok when the DB ping succeeds', async () => {
    prismaPing.mockResolvedValueOnce(undefined);
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.info.database.status).toBe('up');
    expect(prismaPing).toHaveBeenCalledTimes(1);
  });

  it('GET /health/ready returns 503 when the DB is unreachable', async () => {
    prismaPing.mockRejectedValueOnce(new Error('connection refused'));
    const res = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(res.body.status).toBe('error');
    expect(res.body.error.database.status).toBe('down');
  });
});
