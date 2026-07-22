import { Injectable } from '@nestjs/common';
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

  /** Find a user by phone or create one; used at OTP-verify time. */
  async findOrCreateByPhone(phone: string): Promise<UserView> {
    const user = await this.prisma.user.upsert({
      where: { phone },
      create: { phone },
      update: {},
      select: { id: true, phone: true, phoneVerified: true, displayName: true },
    });
    return user;
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
