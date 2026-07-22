import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppConfigModule } from '@akabbo/config';
import { PrismaModule, PrismaService } from '@akabbo/prisma';
import { AccessModule, Actor, OperationContext } from '@akabbo/access';
import { IdentityModule } from '@akabbo/identity';
import {
  EventService,
  FulfillmentService,
  LedgerModule,
  MembershipService,
  PersonService,
  PledgeService,
} from '@akabbo/ledger';
import { PublicSettingsService, TransparencyModule } from '@akabbo/transparency';
import { PublicApiModule } from '../apps/api/src/public/public-api.module';

/**
 * Phase 5 HTTP DoD — the concerns that live in the controller/guard, not the
 * service: the public routes need NO auth, map access failures to 404/403,
 * serve conditional GETs (ETag → 304, Part 12/14), and structurally expose no
 * write route (Part 26). The projection correctness lives in the service spec.
 */
describe('Phase 5 — public API surface (e2e)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let events: EventService;
  let membership: MembershipService;
  let people: PersonService;
  let pledges: PledgeService;
  let fulfillments: FulfillmentService;
  let settings: PublicSettingsService;

  let seq = 0;
  const makeUser = async (): Promise<Actor> => {
    const u = await prisma.user.create({
      data: { phone: `+256708${String(seq++).padStart(6, '0')}`, phoneVerified: true },
      select: { id: true },
    });
    return { userId: u.id, phoneVerified: true };
  };
  const ctxFor = async (actor: Actor, eventId: string): Promise<OperationContext> => ({
    actor,
    event: await membership.requireContext(actor, eventId),
  });

  async function seed(): Promise<{ ctx: OperationContext; slug: string }> {
    const owner = await makeUser();
    const event = await events.createEvent(owner, { name: 'Public Wedding', targetAmount: 10_000_000n });
    const ctx = await ctxFor(owner, event.id);
    const p = await people.createPerson(ctx, { displayName: 'Jane', phone: '+256770009999' });
    const pl = await pledges.createPledge(ctx, { personId: p.id, committedValue: 4_000_000n });
    await fulfillments.recordFulfillment(ctx, { pledgeId: pl.id, value: 2_500_000n });
    const { slug } = await prisma.event.findUniqueOrThrow({
      where: { id: event.id },
      select: { slug: true },
    });
    return { ctx, slug };
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        AppConfigModule,
        PrismaModule,
        AccessModule,
        IdentityModule,
        LedgerModule,
        TransparencyModule,
        PublicApiModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    (BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (
      this: bigint,
    ): string {
      return this.toString();
    };
    await app.init();
    prisma = moduleRef.get(PrismaService);
    events = moduleRef.get(EventService);
    membership = moduleRef.get(MembershipService);
    people = moduleRef.get(PersonService);
    pledges = moduleRef.get(PledgeService);
    fulfillments = moduleRef.get(FulfillmentService);
    settings = moduleRef.get(PublicSettingsService);
  });

  afterAll(async () => {
    await app.close();
    await moduleRef.close();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE payment_instruction, event_announcement, invitation, usage_event, pending_confirmation, outbox, audit_event, allocation, fulfillment, pledge, budget_item, budget, person, event_member, event, "user", auth_otp_challenge RESTART IDENTITY CASCADE',
    );
  });

  it('serves the public page with NO auth and only public fields', async () => {
    const { slug } = await seed();
    const res = await request(app.getHttpServer()).get(`/public/events/${slug}`).expect(200);

    expect(res.body.name).toBe('Public Wedding');
    expect(res.body.totalReceived).toBe('2500000');
    expect(res.body.percentCovered).toBe(25);
    // No private leakage over the wire.
    expect(JSON.stringify(res.body)).not.toContain('+25677');
    // Cache headers present.
    expect(res.headers['cache-control']).toContain('max-age');
    expect(res.headers['etag']).toBeTruthy();
  });

  it('supports conditional GET: matching If-None-Match → 304 (Part 12/14)', async () => {
    const { slug } = await seed();
    const first = await request(app.getHttpServer()).get(`/public/events/${slug}`).expect(200);
    const etag = first.headers['etag'];
    expect(etag).toBeTruthy();

    await request(app.getHttpServer())
      .get(`/public/events/${slug}`)
      .set('If-None-Match', etag)
      .expect(304);
  });

  it('maps a revoked link to 404 and a token-gated link to 403 (Part 20)', async () => {
    const { ctx, slug } = await seed();

    await settings.updateSettings(ctx, { isPublic: false });
    await request(app.getHttpServer()).get(`/public/events/${slug}`).expect(404);

    await settings.updateSettings(ctx, { isPublic: true });
    const { accessToken } = await settings.rotateAccessToken(ctx);
    await request(app.getHttpServer()).get(`/public/events/${slug}`).expect(403);
    await request(app.getHttpServer())
      .get(`/public/events/${slug}`)
      .query({ t: accessToken })
      .expect(200);
  });

  it('a missing slug is a 404, never a 500', async () => {
    await request(app.getHttpServer()).get('/public/events/does-not-exist').expect(404);
  });

  it('is read-only by construction: no public write route exists', async () => {
    const { slug } = await seed();
    // There is no mutating verb on the public surface at all.
    await request(app.getHttpServer()).post(`/public/events/${slug}`).expect(404);
    await request(app.getHttpServer()).patch(`/public/events/${slug}/settings`).expect(404);
    await request(app.getHttpServer()).delete(`/public/events/${slug}`).expect(404);
  });
});
