import { ForbiddenException } from '@nestjs/common';
import { EventRole } from '@prisma/client';
import { PermissionService } from './permission.service';
import { ACTIONS, Action } from './actions';

describe('PermissionService (deterministic can(role, action) — §3.6)', () => {
  const svc = new PermissionService();

  it('OWNER can perform every action', () => {
    for (const action of ACTIONS) {
      expect(svc.can(EventRole.OWNER, action)).toBe(true);
    }
  });

  it('VIEWER can only read; every write is denied (Phase 1 DoD)', () => {
    const writes: Action[] = [
      'event:update',
      'member:manage',
      'person:write',
      'pledge:write',
      'pledge:cancel',
      'fulfillment:write',
      'fulfillment:correct',
    ];
    for (const w of writes) {
      expect(svc.can(EventRole.VIEWER, w)).toBe(false);
    }
    expect(svc.can(EventRole.VIEWER, 'event:read')).toBe(true);
  });

  it('VIEWER sees the redacted funding summary but NOT amounts (finance privacy, §12)', () => {
    expect(svc.can(EventRole.VIEWER, 'ledger:read_funding')).toBe(true);
    expect(svc.can(EventRole.VIEWER, 'ledger:read_amounts')).toBe(false);
  });

  it('CO_OWNER is a peer of OWNER, including membership control', () => {
    expect(svc.can(EventRole.CO_OWNER, 'member:manage')).toBe(true);
    expect(svc.can(EventRole.CO_OWNER, 'ledger:read_amounts')).toBe(true);
    expect(svc.can(EventRole.CO_OWNER, 'fulfillment:correct')).toBe(true);
  });

  it('FINANCE may write the ledger but not manage members or event settings', () => {
    expect(svc.can(EventRole.FINANCE, 'pledge:write')).toBe(true);
    expect(svc.can(EventRole.FINANCE, 'fulfillment:correct')).toBe(true);
    expect(svc.can(EventRole.FINANCE, 'member:manage')).toBe(false);
    expect(svc.can(EventRole.FINANCE, 'event:update')).toBe(false);
  });

  it('COORDINATOR may update the event but not manage members', () => {
    expect(svc.can(EventRole.COORDINATOR, 'event:update')).toBe(true);
    expect(svc.can(EventRole.COORDINATOR, 'member:manage')).toBe(false);
  });

  it('only OWNER may manage members', () => {
    expect(svc.can(EventRole.OWNER, 'member:manage')).toBe(true);
    expect(svc.can(EventRole.COORDINATOR, 'member:manage')).toBe(false);
    expect(svc.can(EventRole.FINANCE, 'member:manage')).toBe(false);
    expect(svc.can(EventRole.VIEWER, 'member:manage')).toBe(false);
  });

  it('assert() throws ForbiddenException when denied, is silent when allowed', () => {
    expect(() => svc.assert(EventRole.VIEWER, 'pledge:write')).toThrow(ForbiddenException);
    expect(() => svc.assert(EventRole.OWNER, 'pledge:write')).not.toThrow();
  });
});
