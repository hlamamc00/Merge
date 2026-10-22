/**
 * Bulk worker import from CSV or a spreadsheet (first sheet). Stateless: preview and apply both
 * re-parse the uploaded content so nothing has to be kept in memory between the two calls.
 */
import ExcelJS from 'exceljs';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { DocumentType, JobRole, Skill, type DocumentType as DT, type JobRole as JR, type Skill as SK } from '@merge/shared';
import type { Db } from '../db/client.js';
import { sites, workerDocuments, workers } from '../db/schema.js';
import { newId } from '../lib/ids.js';

export const DOCUMENT_TYPES = Object.values(DocumentType) as DT[];

export const BASE_COLUMNS = ['firstName', 'lastName', 'email', 'phone', 'jobRole', 'skills', 'contractedHoursPerWeek', 'maxHoursPerWeek', 'postcode', 'travelRadiusKm', 'homeSite', 'shareable', 'verified', 'invite'] as const;

export function templateColumns(): string[] {
  return [...BASE_COLUMNS, ...DOCUMENT_TYPES.flatMap((t) => [`${t}_reference`, `${t}_expiresAt`])];
}

export function templateCsv(): string {
  const header = templateColumns().join(',');
  const example = ['Aisha', 'Begum', 'aisha.begum@example.com', '07700 900123', 'CARE_ASSISTANT', 'MOVING_AND_HANDLING;DEMENTIA', '30', '48', 'SK4 1AB', '20', 'Main home', 'yes', 'yes', 'yes', ...DOCUMENT_TYPES.flatMap((t) => [`${t.slice(0, 3)}-123456`, '2028-01-31'])].join(',');
  const notes = `# jobRole: one of ${Object.values(JobRole).join(' | ')}. skills: semicolon-separated from ${Object.values(Skill).join(' | ')}. Dates: YYYY-MM-DD or DD/MM/YYYY. shareable/verified/invite: yes or no. Delete this line before uploading.`;
  return `${header}\n${example}\n${notes}\n`;
}

// ---------- parsing ----------

/** RFC 4180-style CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

export async function parseWorkbook(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: string[][] = [];
  ws.eachRow((r) => {
    const values: string[] = [];
    for (let c = 1; c <= r.cellCount; c++) {
      const v = r.getCell(c).value;
      values.push(cellToString(v));
    }
    if (values.some((v) => v.trim() !== '')) rows.push(values);
  });
  return rows;
}

function cellToString(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('result' in v) return cellToString(v.result as ExcelJS.CellValue);
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    return String(v);
  }
  return String(v);
}

export async function parseUpload(fileName: string, content: Buffer): Promise<string[][]> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return parseWorkbook(content);
  return parseCsv(content.toString('utf8')).filter((r) => !(r[0] ?? '').trim().startsWith('#'));
}

/** Header names are matched case-insensitively, ignoring spaces and underscores. */
function normaliseHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

export function rowsToObjects(rows: string[][]): Array<{ line: number; values: Record<string, string> }> {
  if (rows.length === 0) return [];
  const headers = rows[0]!.map(normaliseHeader);
  const wanted = new Map(templateColumns().map((c) => [normaliseHeader(c), c]));
  const mapping = headers.map((h) => wanted.get(h) ?? null);
  return rows.slice(1).map((r, i) => {
    const values: Record<string, string> = {};
    r.forEach((v, c) => {
      const key = mapping[c];
      if (key) values[key] = (v ?? '').trim();
    });
    return { line: i + 2, values }; // spreadsheet line number (header is line 1)
  });
}

// ---------- validation ----------

const yes = (v: string | undefined) => /^(y|yes|true|1)$/i.test((v ?? '').trim());
const optNumber = (v: string | undefined) => (v == null || v.trim() === '' ? undefined : Number(v));

export function parseDate(v: string | undefined): Date | null | 'invalid' {
  if (!v || v.trim() === '') return null;
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return Number.isNaN(d.getTime()) ? 'invalid' : d;
  }
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
  if (m) {
    const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
    return Number.isNaN(d.getTime()) ? 'invalid' : d;
  }
  return 'invalid';
}

export interface ValidRow {
  line: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  jobRole: JR;
  skills: SK[];
  contractedHoursPerWeek: number | null;
  maxHoursPerWeek: number | null;
  postcode: string | null;
  travelRadiusKm: number | null;
  homeSiteId: string | null;
  shareable: boolean;
  verified: boolean;
  invite: boolean;
  documents: Array<{ type: DT; reference: string | null; expiresAt: Date | null }>;
}

const zRow = z.object({
  firstName: z.string().trim().min(1, 'firstName is required').max(60),
  lastName: z.string().trim().min(1, 'lastName is required').max(60),
  email: z.string().trim().email('email is not valid').optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional(),
  jobRole: z.nativeEnum(JobRole, { errorMap: () => ({ message: `jobRole must be one of ${Object.values(JobRole).join(', ')}` }) }),
  contractedHoursPerWeek: z.number().min(0).max(80).optional(),
  maxHoursPerWeek: z.number().min(1).max(80).optional(),
  postcode: z.string().trim().max(10).optional(),
  travelRadiusKm: z.number().min(0).max(500).optional(),
});

export function validateRows(objects: Array<{ line: number; values: Record<string, string> }>, orgSites: Array<{ id: string; name: string }>): { valid: ValidRow[]; errors: Array<{ row: number; message: string }> } {
  const valid: ValidRow[] = [];
  const errors: Array<{ row: number; message: string }> = [];
  const siteByName = new Map(orgSites.map((s) => [s.name.trim().toLowerCase(), s.id]));
  const seenEmails = new Set<string>();
  for (const { line, values } of objects) {
    const problems: string[] = [];
    const parsed = zRow.safeParse({
      firstName: values.firstName,
      lastName: values.lastName,
      email: values.email ?? '',
      phone: values.phone,
      jobRole: values.jobRole?.trim().toUpperCase().replace(/\s+/g, '_'),
      contractedHoursPerWeek: optNumber(values.contractedHoursPerWeek),
      maxHoursPerWeek: optNumber(values.maxHoursPerWeek),
      postcode: values.postcode,
      travelRadiusKm: optNumber(values.travelRadiusKm),
    });
    if (!parsed.success) problems.push(...parsed.error.issues.map((i) => i.message));
    const skills: SK[] = [];
    for (const raw of (values.skills ?? '').split(/[;|]/).map((s) => s.trim()).filter(Boolean)) {
      const key = raw.toUpperCase().replace(/[\s-]+/g, '_');
      if ((Object.values(Skill) as string[]).includes(key)) skills.push(key as SK);
      else problems.push(`unknown skill "${raw}"`);
    }
    let homeSiteId: string | null = null;
    if (values.homeSite && values.homeSite.trim() !== '') {
      homeSiteId = siteByName.get(values.homeSite.trim().toLowerCase()) ?? null;
      if (!homeSiteId) problems.push(`homeSite "${values.homeSite}" is not one of your sites`);
    }
    const invite = yes(values.invite);
    const email = parsed.success && parsed.data.email ? parsed.data.email.toLowerCase() : null;
    if (invite && !email) problems.push('invite=yes needs an email');
    if (email) {
      if (seenEmails.has(email)) problems.push(`duplicate email ${email} in the file`);
      seenEmails.add(email);
    }
    const documents: ValidRow['documents'] = [];
    for (const type of DOCUMENT_TYPES) {
      const ref = values[`${type}_reference`];
      const exp = values[`${type}_expiresAt`];
      if ((!ref || ref === '') && (!exp || exp === '')) continue;
      const d = parseDate(exp);
      if (d === 'invalid') {
        problems.push(`${type}_expiresAt "${exp}" is not a date`);
        continue;
      }
      documents.push({ type, reference: ref && ref !== '' ? ref : null, expiresAt: d });
    }
    if (problems.length > 0) {
      errors.push({ row: line, message: problems.join('; ') });
      continue;
    }
    const d = parsed.data!;
    valid.push({
      line,
      firstName: d.firstName,
      lastName: d.lastName,
      email,
      phone: d.phone && d.phone !== '' ? d.phone : null,
      jobRole: d.jobRole,
      skills: skills.length ? skills : ['MOVING_AND_HANDLING'],
      contractedHoursPerWeek: d.contractedHoursPerWeek ?? null,
      maxHoursPerWeek: d.maxHoursPerWeek ?? null,
      postcode: d.postcode && d.postcode !== '' ? d.postcode.toUpperCase() : null,
      travelRadiusKm: d.travelRadiusKm ?? null,
      homeSiteId,
      shareable: values.shareable == null || values.shareable === '' ? true : yes(values.shareable),
      verified: yes(values.verified),
      invite,
      documents,
    });
  }
  return { valid, errors };
}

// ---------- applying ----------

export interface ApplyResult {
  created: number;
  updated: number;
  invited: number;
  documents: number;
  failures: Array<{ row: number; message: string }>;
  workerIds: string[];
}

export async function applyRows(
  db: Db,
  orgId: string,
  rows: ValidRow[],
  opts: { invite: boolean; verifierUserId: string | null },
  now: Date,
  inviteWorker: (worker: { id: string; email: string; firstName: string; lastName: string }) => Promise<void>,
): Promise<ApplyResult> {
  const result: ApplyResult = { created: 0, updated: 0, invited: 0, documents: 0, failures: [], workerIds: [] };
  for (const r of rows) {
    try {
      const existing = r.email ? db.select().from(workers).where(and(eq(workers.orgId, orgId), eq(workers.email, r.email))).get() : undefined;
      const fields = {
        firstName: r.firstName,
        lastName: r.lastName,
        email: r.email,
        phone: r.phone,
        jobRole: r.jobRole,
        skills: r.skills,
        shareable: r.shareable,
        contractedHoursPerWeek: r.contractedHoursPerWeek,
        maxHoursPerWeek: r.maxHoursPerWeek,
        postcode: r.postcode,
        travelRadiusKm: r.travelRadiusKm,
        homeSiteId: r.homeSiteId,
        updatedAt: now,
      };
      let workerId: string;
      if (existing) {
        db.update(workers).set(fields).where(eq(workers.id, existing.id)).run();
        workerId = existing.id;
        result.updated++;
      } else {
        workerId = newId('wrk');
        db.insert(workers).values({ id: workerId, orgId, status: 'ACTIVE', optedOutOf48h: false, createdAt: now, ...fields }).run();
        result.created++;
      }
      result.workerIds.push(workerId);
      for (const doc of r.documents) {
        db.insert(workerDocuments)
          .values({ id: newId('doc'), workerId, type: doc.type, reference: doc.reference, issuedAt: null, expiresAt: doc.expiresAt, fileUrl: null, verifiedAt: r.verified ? now : null, verifiedByUserId: r.verified ? opts.verifierUserId : null, notes: 'Imported', createdAt: now })
          .run();
        result.documents++;
      }
      if (opts.invite && r.invite && r.email) {
        const w = db.select({ userId: workers.userId }).from(workers).where(eq(workers.id, workerId)).get();
        if (!w?.userId) {
          await inviteWorker({ id: workerId, email: r.email, firstName: r.firstName, lastName: r.lastName });
          result.invited++;
        }
      }
    } catch (err) {
      result.failures.push({ row: r.line, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

export function orgSites(db: Db, orgId: string): Array<{ id: string; name: string }> {
  return db.select({ id: sites.id, name: sites.name }).from(sites).where(eq(sites.orgId, orgId)).all();
}
