import { createHash } from 'node:crypto';
import { Controller, Get, Header, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PublicEventView, PublicViewService } from '@akabbo/transparency';
import { PublicRateLimitGuard } from './public-rate-limit.guard';

/**
 * The UNAUTHENTICATED public transparency surface (transparency spec Part 22/27).
 *
 * Click link → see event → understand progress. NO auth, NO account, NO AI.
 * Every route resolves a public SLUG (+ optional `?t=` token) through the ONE
 * projection service — there is no path from here to any write service or member
 * context. Responses are cache-friendly (ETag + short max-age) so the page can
 * be served widely and cheaply (Part 12/13); a CDN plugs in on top later.
 *
 * `:slug` deliberately means the public slug, never an internal id (Part 10).
 */
@Controller('public/events/:slug')
@UseGuards(PublicRateLimitGuard)
export class PublicController {
  constructor(private readonly view: PublicViewService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
  async event(
    @Param('slug') slug: string,
    @Query('t') token: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicEventView | undefined> {
    const view = await this.view.getPublicEventView(slug, this.token(token, req));
    return this.withCache(req, res, view);
  }

  /** Just the headline totals — the fastest, most-cached slice. */
  @Get('summary')
  @Header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
  async summary(
    @Param('slug') slug: string,
    @Query('t') token: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<object | undefined> {
    const v = await this.view.getPublicEventView(slug, this.token(token, req));
    return this.withCache(req, res, {
      slug: v.slug,
      name: v.name,
      description: v.description,
      eventDate: v.eventDate,
      status: v.status,
      currency: v.currency,
      target: v.target,
      totalPledged: v.totalPledged,
      totalReceived: v.totalReceived,
      totalOutstanding: v.totalOutstanding,
      remaining: v.remaining,
      percentCovered: v.percentCovered,
      contributorCount: v.contributorCount,
      revision: v.revision,
    });
  }

  @Get('budget')
  @Header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
  async budget(
    @Param('slug') slug: string,
    @Query('t') token: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<object | undefined> {
    const v = await this.view.getPublicEventView(slug, this.token(token, req));
    return this.withCache(req, res, { budget: v.budget, visibility: v.visibility.budget });
  }

  @Get('contributors')
  @Header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
  async contributors(
    @Param('slug') slug: string,
    @Query('t') token: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<object | undefined> {
    const v = await this.view.getPublicEventView(slug, this.token(token, req));
    return this.withCache(req, res, {
      contributors: v.contributors,
      contributorCount: v.contributorCount,
      visibility: v.visibility.contributors,
    });
  }

  @Get('announcements')
  @Header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
  async announcements(
    @Param('slug') slug: string,
    @Query('t') token: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<object | undefined> {
    const v = await this.view.getPublicEventView(slug, this.token(token, req));
    return this.withCache(req, res, { announcements: v.announcements });
  }

  /** "How to contribute" — the organizer's own payment channels (Part 18/19). */
  @Get('contribute')
  @Header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')
  async contribute(
    @Param('slug') slug: string,
    @Query('t') token: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<object | undefined> {
    const v = await this.view.getPublicEventView(slug, this.token(token, req));
    return this.withCache(req, res, { paymentInstructions: v.paymentInstructions });
  }

  /** Token may arrive as `?t=` or the `x-akabbo-access-token` header. */
  private token(query: string | undefined, req: Request): string | undefined {
    const header = req.headers['x-akabbo-access-token'];
    return query ?? (typeof header === 'string' ? header : undefined);
  }

  /**
   * Content-hash ETag + conditional GET. If the client's `If-None-Match` matches
   * the current body hash we return 304 with no body (Part 12/14: short cache,
   * cheap revalidation), otherwise we set the ETag and return the body.
   */
  private withCache<T>(req: Request, res: Response, body: T): T | undefined {
    const etag = `"${createHash('sha1').update(JSON.stringify(body)).digest('base64url')}"`;
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.status(304);
      return undefined;
    }
    return body;
  }
}
