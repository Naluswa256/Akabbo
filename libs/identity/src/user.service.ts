import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@akabbo/prisma';

export interface UserView {
  id: string;
  phone: string;
  phoneVerified: boolean;
  displayName: string | null;
}

/**
 * Users (Identity & Access). The `user` table is global (not event-scoped), so
 * these operations run outside RLS. A user gains access to data only through
 * event memberships (see MembershipService).
 */
@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Find a user by phone or create one; used at OTP-verify time. Reports
   * `isNew` explicitly (rather than inferring from timestamps) so the caller
   * can trigger signup-only side effects — e.g. the free trial — exactly
   * once, on genuine account creation, never on a returning user's login.
   * Optimistic create + fall back on conflict: the unique constraint on
   * `phone` is the arbiter for concurrent verifies of the same new number,
   * not a separate check-then-create window.
   */
  async findOrCreateByPhone(phone: string): Promise<UserView & { isNew: boolean }> {
    try {
      const created = await this.prisma.user.create({
        data: { phone },
        select: { id: true, phone: true, phoneVerified: true, displayName: true },
      });
      return { ...created, isNew: true };
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
        throw err;
      }
      const existing = await this.prisma.user.findUniqueOrThrow({
        where: { phone },
        select: { id: true, phone: true, phoneVerified: true, displayName: true },
      });
      return { ...existing, isNew: false };
    }
  }

  async markPhoneVerified(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { phoneVerified: true },
    });
  }

  async getById(userId: string): Promise<UserView | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true, phoneVerified: true, displayName: true },
    });
  }
}
