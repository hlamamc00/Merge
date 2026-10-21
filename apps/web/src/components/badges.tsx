import { JOB_ROLE_LABELS, SKILL_LABELS, type DispatchTier, type JobRole, type Skill } from '@merge/shared';
import { Badge } from './ui';
import { humanise } from '../lib/format';

export function TierBadge({ tier, className }: { tier: DispatchTier | null | undefined; className?: string }) {
  if (!tier) return null;
  const map = { PRIORITY: { tone: 'amber' as const, label: 'Priority' }, AGENCY: { tone: 'violet' as const, label: 'Agency bank' }, NETWORK: { tone: 'slate' as const, label: 'Network' } };
  const m = map[tier];
  return (
    <Badge tone={m.tone} className={className}>
      {tier === 'PRIORITY' && '★ '}
      {m.label}
    </Badge>
  );
}

export function ComplianceBadge({ status }: { status: 'COMPLIANT' | 'EXPIRING' | 'NON_COMPLIANT' }) {
  const map = { COMPLIANT: { tone: 'green' as const, label: 'Compliant' }, EXPIRING: { tone: 'amber' as const, label: 'Expiring soon' }, NON_COMPLIANT: { tone: 'red' as const, label: 'Not compliant' } };
  const m = map[status];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

const statusTones: Record<string, 'slate' | 'green' | 'amber' | 'red' | 'violet' | 'blue' | 'brand'> = {
  DRAFT: 'slate',
  OPEN: 'blue',
  FILLED: 'green',
  IN_PROGRESS: 'violet',
  COMPLETED: 'green',
  CANCELLED: 'red',
  EXPIRED: 'red',
  REQUESTED: 'amber',
  OFFERED: 'violet',
  CONFIRMED: 'green',
  DECLINED: 'red',
  WITHDRAWN: 'slate',
  NO_SHOW: 'red',
  SUBMITTED: 'amber',
  APPROVED: 'green',
  DISPUTED: 'red',
  REJECTED: 'red',
  ISSUED: 'blue',
  PAID: 'green',
  VOID: 'slate',
  ACTIVE: 'green',
  FULFILLED: 'blue',
  SUSPENDED: 'red',
  PENDING: 'amber',
  INACTIVE: 'slate',
  ON_LEAVE: 'amber',
  VALID: 'green',
  EXPIRING: 'amber',
  MISSING: 'red',
  PENDING_VERIFICATION: 'amber',
  SURPLUS: 'brand',
  SHORTAGE: 'amber',
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTones[status] ?? 'slate'}>{humanise(status)}</Badge>;
}

export function RoleLabel({ role }: { role: JobRole }) {
  return <>{JOB_ROLE_LABELS[role] ?? humanise(role)}</>;
}

export function skillLabel(s: Skill | string): string {
  return (SKILL_LABELS as Record<string, string>)[s] ?? humanise(s);
}

export function UrgentBadge({ urgent }: { urgent: boolean }) {
  return urgent ? <Badge tone="red">Urgent</Badge> : null;
}
