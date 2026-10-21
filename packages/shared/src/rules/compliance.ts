import { ComplianceStatus, DocumentStatus, DocumentType, type JobRole } from '../enums.js';
import { addDays } from '../time.js';

const BASE_DOCUMENTS: readonly DocumentType[] = [
  DocumentType.DBS,
  DocumentType.RIGHT_TO_WORK,
  DocumentType.PHOTO_ID,
  DocumentType.MANDATORY_TRAINING,
  DocumentType.MOVING_AND_HANDLING_TRAINING,
  DocumentType.SAFEGUARDING_TRAINING,
];

/** Documents a worker must hold, valid and verified, before they can be sent to a shift in the given role. */
export function requiredDocumentsForRole(role: JobRole): DocumentType[] {
  switch (role) {
    case 'NURSE':
      return [...BASE_DOCUMENTS, DocumentType.NMC_PIN, DocumentType.MEDICATION_TRAINING];
    case 'SENIOR_CARER':
    case 'TEAM_LEADER':
      return [...BASE_DOCUMENTS, DocumentType.MEDICATION_TRAINING];
    default:
      return [...BASE_DOCUMENTS];
  }
}

export interface ComplianceDocumentLike {
  type: DocumentType;
  expiresAt?: Date | null;
  verifiedAt?: Date | null;
}

export const EXPIRING_SOON_DAYS = 30;

export function documentStatus(
  doc: ComplianceDocumentLike | undefined,
  onDate: Date,
  expiringSoonDays = EXPIRING_SOON_DAYS,
): DocumentStatus {
  if (!doc) return DocumentStatus.MISSING;
  if (!doc.verifiedAt) return DocumentStatus.PENDING_VERIFICATION;
  if (doc.expiresAt) {
    if (doc.expiresAt.getTime() <= onDate.getTime()) return DocumentStatus.EXPIRED;
    if (doc.expiresAt.getTime() <= addDays(onDate, expiringSoonDays).getTime()) return DocumentStatus.EXPIRING;
  }
  return DocumentStatus.VALID;
}

export interface ComplianceItem {
  type: DocumentType;
  status: DocumentStatus;
  expiresAt?: Date | null;
}

export interface ComplianceSummary {
  status: ComplianceStatus;
  items: ComplianceItem[];
}

/**
 * Compliance of a worker against the documents required for a role, as of a date
 * (use the shift date, not today, so a DBS expiring next week blocks next month's shift).
 * When no document is present for a type the item is MISSING. The most recently
 * expiring valid document of each type is used.
 */
export function complianceSummary(
  documents: ComplianceDocumentLike[],
  role: JobRole,
  onDate: Date,
  extraRequired: DocumentType[] = [],
): ComplianceSummary {
  const required = Array.from(new Set([...requiredDocumentsForRole(role), ...extraRequired]));
  const items: ComplianceItem[] = required.map((type) => {
    const candidates = documents.filter((d) => d.type === type);
    const best = pickBestDocument(candidates, onDate);
    return { type, status: documentStatus(best, onDate), expiresAt: best?.expiresAt ?? null };
  });
  const anyBlocking = items.some((i) =>
    i.status === DocumentStatus.MISSING ||
    i.status === DocumentStatus.EXPIRED ||
    i.status === DocumentStatus.PENDING_VERIFICATION,
  );
  const anyExpiring = items.some((i) => i.status === DocumentStatus.EXPIRING);
  return {
    status: anyBlocking
      ? ComplianceStatus.NON_COMPLIANT
      : anyExpiring
        ? ComplianceStatus.EXPIRING
        : ComplianceStatus.COMPLIANT,
    items,
  };
}

function pickBestDocument(docs: ComplianceDocumentLike[], onDate: Date): ComplianceDocumentLike | undefined {
  if (docs.length === 0) return undefined;
  const rank = (d: ComplianceDocumentLike) => {
    const s = documentStatus(d, onDate);
    return s === DocumentStatus.VALID ? 4 : s === DocumentStatus.EXPIRING ? 3 : s === DocumentStatus.PENDING_VERIFICATION ? 2 : s === DocumentStatus.EXPIRED ? 1 : 0;
  };
  return [...docs].sort((a, b) => {
    const r = rank(b) - rank(a);
    if (r !== 0) return r;
    return (b.expiresAt?.getTime() ?? Infinity) - (a.expiresAt?.getTime() ?? Infinity);
  })[0];
}
