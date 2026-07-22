import { ForbiddenException, NotFoundException } from '@nestjs/common';

/**
 * The requested public event does not exist OR its link has been revoked
 * (`isPublic = false`). We deliberately use a single 404 for both so a revoked
 * link is indistinguishable from a never-existing one — no existence oracle
 * (transparency spec Part 20).
 */
export class PublicEventNotFoundException extends NotFoundException {
  constructor() {
    super('No public event found for this link');
  }
}

/**
 * The event is invite-only (`publicAccessToken` set) and the caller supplied a
 * missing or wrong token. 403 rather than 404 because the slug is legitimately
 * known to whoever shared it — only the token is wrong.
 */
export class PublicTokenRequiredException extends ForbiddenException {
  constructor() {
    super('This event link requires a valid access token');
  }
}
