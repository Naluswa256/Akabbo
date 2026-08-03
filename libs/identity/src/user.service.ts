import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@akabbo/prisma';

export interface UserView {
  id: string;
  phone: string | null;
  phoneVerified: boolean;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}

const USER_VIEW_SELECT = {
  id: true,
  phone: true,
  phoneVerified: true,
  email: true,
  emailVerified: true,
  displayName: true,
} as const;

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
        select: USER_VIEW_SELECT,
      });
      return { ...created, isNew: true };
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
        throw err;
      }
      const existing = await this.prisma.user.findUniqueOrThrow({
        where: { phone },
        select: USER_VIEW_SELECT,
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

  /**
   * Same optimistic-create/catch-P2002 pattern as {@link findOrCreateByPhone},
   * mirrored for the email channel: the unique constraint on `email` is the
   * arbiter for concurrent verifies of the same new address, not a separate
   * check-then-create window.
   */
  async findOrCreateByEmail(email: string): Promise<UserView & { isNew: boolean }> {
    try {
      const created = await this.prisma.user.create({
        data: { email },
        select: USER_VIEW_SELECT,
      });
      return { ...created, isNew: true };
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
        throw err;
      }
      const existing = await this.prisma.user.findUniqueOrThrow({
        where: { email },
        select: USER_VIEW_SELECT,
      });
      return { ...existing, isNew: false };
    }
  }

  async markEmailVerified(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { emailVerified: true },
    });
  }

  async getById(userId: string): Promise<UserView | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: USER_VIEW_SELECT,
    });
  }
}
