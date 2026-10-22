import type { NotificationType, UserRole } from '@merge/shared';

export interface ImportPreview {
  jobId: string;
  totalRows: number;
  validRows: number;
  invitable: number;
  errors: Array<{ row: number; message: string }>;
  sample: Array<{ line: number; name: string; email: string | null; jobRole: string; skills: string[]; homeSiteId: string | null; documents: number; invite: boolean }>;
}

export interface ImportResult {
  jobId: string;
  created: number;
  updated: number;
  invited: number;
  documents: number;
  failed: number;
  errors: Array<{ row: number; message: string }>;
  workerIds: string[];
}

export interface ImportJob {
  id: string;
  fileName: string | null;
  status: 'PREVIEW' | 'APPLIED' | 'FAILED';
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  invitedCount: number;
  failedCount: number;
  createdAt: string;
  appliedAt: string | null;
}

export interface InvitationInfo {
  email: string;
  firstName: string;
  lastName: string;
  organisationName: string;
  role: UserRole;
  expiresAt: string;
}

export interface NotificationPreferences {
  emailImmediate: NotificationType[];
  emailDigest: boolean;
  smsImmediate: NotificationType[];
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
  maxDistanceKm: number | null;
  isDefault: boolean;
  phone: string | null;
  email: string;
  defaults: { immediate: NotificationType[]; digest: NotificationType[] };
  types: NotificationType[];
}
