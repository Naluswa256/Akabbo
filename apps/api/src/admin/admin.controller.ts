import { Controller, ForbiddenException, Get, Headers, Param, Query } from '@nestjs/common';
import { AdminUsersService } from '@akabbo/access';
import { ConversationService } from '@akabbo/ai';

/**
 * Admin-only reporting: who's on the platform and what plan they're actually
 * on (product/revenue visibility), plus a read-only "inbox" of every user's
 * AI conversations (product-quality review — what people asked, how the AI
 * answered). There is no admin ROLE in this system yet (see
 * LearningController for the same situation) — gated the identical way, by a
 * shared secret header, not a JWT. Never wired behind AuthGuard on purpose:
 * this surface is for the founder, not any authenticated app user.
 */
@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminUsers: AdminUsersService,
    private readonly conversations: ConversationService,
  ) {}

  private assertAdminSecret(secretHeader?: string): void {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret) {
      throw new ForbiddenException('Admin surface is not configured (ADMIN_SECRET unset)');
    }
    if (!secretHeader || secretHeader !== adminSecret) {
      throw new ForbiddenException('Invalid admin secret key for admin surface');
    }
  }

  /** Every user, their plan/status, and current AI/SMS credit balances. */
  @Get('users')
  async listUsers(@Headers('x-akabbo-admin-secret') secret?: string) {
    this.assertAdminSecret(secret);
    return this.adminUsers.listUsers();
  }

  /** Aggregate counts: how many users are on free trial vs a paid plan, per plan code. */
  @Get('users/summary')
  async usersSummary(@Headers('x-akabbo-admin-secret') secret?: string) {
    this.assertAdminSecret(secret);
    return this.adminUsers.summary();
  }

  /** Every conversation across every user, most recently active first. */
  @Get('conversations')
  async listConversations(
    @Headers('x-akabbo-admin-secret') secret?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    this.assertAdminSecret(secret);
    return this.conversations.listAllForAdmin(
      limit ? Number(limit) : undefined,
      offset ? Number(offset) : undefined,
    );
  }

  /** Full message history for ANY conversation — the "what did they ask, how did the AI answer" view. */
  @Get('conversations/:id/messages')
  async getConversationMessages(
    @Param('id') id: string,
    @Headers('x-akabbo-admin-secret') secret?: string,
  ) {
    this.assertAdminSecret(secret);
    return this.conversations.getMessagesAdmin(id);
  }
}
