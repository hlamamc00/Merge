/**
 * Demo data for Merge: one platform-owning agency with its own bank, four care providers around
 * Greater Manchester, compliant (and a few non-compliant) workers, live capacity flags and open shifts.
 *
 *   npm run db:seed          (refuses to run twice)
 *   npm run db:reset && npm run db:migrate && npm run db:seed
 */
import { eq } from 'drizzle-orm';
import { CapacityFlagKind, DocumentType, JobRole, OrgType, RelationshipKind, ShiftVisibility, Skill, UserRole, addDays, addHours, requiredDocumentsForRole } from '@merge/shared';
import { config } from '../config.js';
import { openDatabase, runMigrations, type Db } from './client.js';
import { hashPassword } from '../lib/auth.js';
import { newId } from '../lib/ids.js';
import { Notifier, consoleChannel } from '../lib/notify.js';
import { createFlag } from '../services/capacity.js';
import { requestShift, confirmAssignment } from '../services/assignments.js';
import { publishShift } from '../services/shifts.js';
import { ensureSettings, getSettings } from '../services/settings.js';
import { orgRelationships, organisations, platformSettings, shifts, sites, users, workerDocuments, workers, type Shift, type Site, type Worker } from './schema.js';

const DEMO_PASSWORD = 'password123';

async function main() {
  const { db, sqlite } = openDatabase(config.databaseUrl);
  runMigrations(db);
  const now = new Date();
  ensureSettings(db, now);
  if (db.select({ id: organisations.id }).from(organisations).where(eq(organisations.type, OrgType.AGENCY)).get()) {
    console.log('Database already seeded (an agency exists). Run "npm run db:reset" first to start over.');
    sqlite.close();
    return;
  }
  const notifier = new Notifier(db, [], () => now);
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  // ---------- Organisations ----------
  const agency = org(db, now, { name: 'Merge Staffing', type: OrgType.AGENCY, city: 'Manchester', postcode: 'M1 4BT', lat: 53.4794, lng: -2.2453, defaultChargeRate: 19, email: 'hello@merge.local' });
  db.update(platformSettings).set({ ownerOrgId: agency.id, updatedAt: now }).where(eq(platformSettings.id, 'default')).run();
  const oakwood = org(db, now, { name: 'Oakwood Care Homes', type: OrgType.PROVIDER, city: 'Didsbury', postcode: 'M20 2RN', lat: 53.4186, lng: -2.2311, serviceTypes: ['RESIDENTIAL', 'NURSING'], defaultChargeRate: 18, email: 'rota@oakwood.local' });
  const riverside = org(db, now, { name: 'Riverside Living', type: OrgType.PROVIDER, city: 'Stockport', postcode: 'SK4 1AB', lat: 53.4106, lng: -2.1575, serviceTypes: ['RESIDENTIAL'], defaultChargeRate: 17.5, email: 'office@riverside.local', workerSelfServiceAllowed: true });
  const bright = org(db, now, { name: 'Bright Horizons Support', type: OrgType.PROVIDER, city: 'Sale', postcode: 'M33 7XY', lat: 53.4245, lng: -2.3223, serviceTypes: ['SUPPORTED_LIVING', 'LEARNING_DISABILITY'], defaultChargeRate: 16.5, email: 'team@brighthorizons.local' });
  const pennine = org(db, now, { name: 'Pennine Nursing', type: OrgType.PROVIDER, city: 'Oldham', postcode: 'OL1 3DF', lat: 53.5409, lng: -2.1114, serviceTypes: ['NURSING'], defaultChargeRate: 22, email: 'nursing@pennine.local' });

  // ---------- Users ----------
  await user(db, now, passwordHash, agency.id, 'admin@merge.local', 'Priya', 'Shah', UserRole.PLATFORM_ADMIN);
  await user(db, now, passwordHash, agency.id, 'bank@merge.local', 'Tom', 'Reid', UserRole.ORG_MANAGER);
  const oakAdmin = await user(db, now, passwordHash, oakwood.id, 'admin@oakwood.local', 'Grace', 'Okafor', UserRole.ORG_ADMIN);
  await user(db, now, passwordHash, oakwood.id, 'rota@oakwood.local', 'Liam', 'Hughes', UserRole.ORG_MANAGER);
  const rivAdmin = await user(db, now, passwordHash, riverside.id, 'admin@riverside.local', 'Amira', 'Khan', UserRole.ORG_ADMIN);
  await user(db, now, passwordHash, bright.id, 'admin@brighthorizons.local', 'Sam', 'Walker', UserRole.ORG_ADMIN);
  const penAdmin = await user(db, now, passwordHash, pennine.id, 'admin@pennine.local', 'Chloe', 'Bennett', UserRole.ORG_ADMIN);

  // ---------- Sites ----------
  const oakManor = site(db, now, oakwood.id, { name: 'Oakwood Manor', serviceType: 'NURSING', addressLine1: '12 Wilmslow Road', city: 'Didsbury', postcode: 'M20 2RN', lat: 53.4186, lng: -2.2311, accessNotes: 'Parking at rear. Sign in at reception; nurse in charge holds the keys.' });
  const oakLodge = site(db, now, oakwood.id, { name: 'Oakwood Lodge', serviceType: 'RESIDENTIAL', addressLine1: '3 Barlow Moor Road', city: 'Chorlton', postcode: 'M21 8BB', lat: 53.4425, lng: -2.2765, accessNotes: 'Keypad entry; code given on confirmation.' });
  site(db, now, riverside.id, { name: 'Riverside House', serviceType: 'RESIDENTIAL', addressLine1: '45 Heaton Moor Road', city: 'Stockport', postcode: 'SK4 1AB', lat: 53.4106, lng: -2.1575 });
  site(db, now, bright.id, { name: 'Bright Horizons – Sale', serviceType: 'SUPPORTED_LIVING', addressLine1: '8 School Road', city: 'Sale', postcode: 'M33 7XY', lat: 53.4245, lng: -2.3223 });
  const penSite = site(db, now, pennine.id, { name: 'Pennine View', serviceType: 'NURSING', addressLine1: '101 Rochdale Road', city: 'Oldham', postcode: 'OL1 3DF', lat: 53.5409, lng: -2.1114, accessNotes: 'Use the staff entrance on Union Street.' });

  // ---------- Workers ----------
  const base: Skill[] = ['MOVING_AND_HANDLING'];
  const agencyWorkers = [
    worker(db, now, agency.id, 'Dan', 'Murphy', 'CARE_ASSISTANT', [...base, 'DEMENTIA', 'MEDICATION'], 'M4 5JD', 53.4847, -2.2302, 20),
    worker(db, now, agency.id, 'Esther', 'Adeyemi', 'SENIOR_CARER', [...base, 'DEMENTIA', 'MEDICATION', 'END_OF_LIFE'], 'M14 5RB', 53.4455, -2.2206, 25),
    worker(db, now, agency.id, 'Yusuf', 'Ali', 'NURSE', [...base, 'MEDICATION', 'PEG_FEEDING', 'CATHETER_CARE'], 'M8 8PB', 53.5064, -2.2412, 30, 28),
  ];
  const oakWorkers = [
    worker(db, now, oakwood.id, 'Maria', 'Nowak', 'CARE_ASSISTANT', [...base, 'DEMENTIA'], 'M20 3GS', 53.42, -2.23, 10),
    worker(db, now, oakwood.id, 'Josh', 'Patel', 'SENIOR_CARER', [...base, 'MEDICATION', 'DEMENTIA'], 'M21 9AA', 53.44, -2.27, 10),
    worker(db, now, oakwood.id, 'Helen', 'Price', 'NURSE', [...base, 'MEDICATION', 'PEG_FEEDING'], 'M19 2FG', 53.43, -2.2, 10),
  ];
  const rivWorkers = [
    worker(db, now, riverside.id, 'Aisha', 'Begum', 'CARE_ASSISTANT', [...base, 'DEMENTIA', 'MEDICATION'], 'SK4 2BC', 53.41, -2.16, 20),
    worker(db, now, riverside.id, 'Connor', 'Byrne', 'CARE_ASSISTANT', [...base, 'DEMENTIA', 'HOIST'], 'SK5 6DE', 53.42, -2.14, 15),
    worker(db, now, riverside.id, 'Fatima', 'Hussain', 'SENIOR_CARER', [...base, 'MEDICATION', 'DEMENTIA', 'END_OF_LIFE'], 'SK4 3EF', 53.405, -2.17, 25),
    worker(db, now, riverside.id, 'George', 'Lam', 'CARE_ASSISTANT', [...base], 'SK3 8GH', 53.4, -2.18, 15),
    worker(db, now, riverside.id, 'Nadia', 'Osei', 'CARE_ASSISTANT', [...base, 'DEMENTIA'], 'SK4 4JK', 53.415, -2.15, 20),
  ];
  const brightWorkers = [
    worker(db, now, bright.id, 'Ben', 'Carter', 'SUPPORT_WORKER', [...base, 'LEARNING_DISABILITIES', 'CHALLENGING_BEHAVIOUR', 'DRIVER'], 'M33 2LM', 53.425, -2.32, 20),
    worker(db, now, bright.id, 'Leah', 'Morgan', 'SUPPORT_WORKER', [...base, 'LEARNING_DISABILITIES', 'EPILEPSY'], 'M33 4NP', 53.43, -2.33, 20),
    worker(db, now, bright.id, 'Ravi', 'Singh', 'SUPPORT_WORKER', [...base, 'MENTAL_HEALTH', 'CHALLENGING_BEHAVIOUR'], 'M41 5QR', 53.45, -2.35, 25),
    worker(db, now, bright.id, 'Zoe', 'Fletcher', 'TEAM_LEADER', [...base, 'MEDICATION', 'LEARNING_DISABILITIES'], 'M33 6ST', 53.42, -2.31, 25),
  ];
  const penWorkers = [
    worker(db, now, pennine.id, 'Olivia', 'Grant', 'NURSE', [...base, 'MEDICATION', 'PEG_FEEDING', 'CATHETER_CARE', 'DIABETES'], 'OL1 2AB', 53.54, -2.11, 30, 30),
    worker(db, now, pennine.id, 'Marcus', 'Dube', 'NURSE', [...base, 'MEDICATION', 'END_OF_LIFE'], 'OL4 3CD', 53.53, -2.08, 30, 30),
    worker(db, now, pennine.id, 'Sophie', 'Ward', 'CARE_ASSISTANT', [...base, 'DEMENTIA'], 'OL2 4EF', 53.55, -2.12, 15),
    worker(db, now, pennine.id, 'Kwame', 'Mensah', 'SENIOR_CARER', [...base, 'MEDICATION', 'DEMENTIA'], 'OL1 5GH', 53.545, -2.1, 20),
  ];

  // Compliance: everyone fully compliant, except George (DBS expiring in 12 days) and Sophie (right-to-work unverified).
  for (const w of [...agencyWorkers, ...oakWorkers, ...rivWorkers, ...brightWorkers, ...penWorkers]) {
    for (const type of requiredDocumentsForRole(w.jobRole)) {
      const expiring = w.firstName === 'George' && type === DocumentType.DBS;
      const unverified = w.firstName === 'Sophie' && type === DocumentType.RIGHT_TO_WORK;
      document(db, now, w.id, type, expiring ? addDays(now, 12) : addDays(now, 300 + Math.floor(Math.random() * 400)), unverified ? null : addDays(now, -30), oakAdmin.id);
    }
  }
  // Riverside lets Aisha log in and pick shifts herself.
  const aisha = rivWorkers[0]!;
  const aishaUser = await user(db, now, passwordHash, riverside.id, 'aisha@riverside.local', aisha.firstName, aisha.lastName, UserRole.WORKER, aisha.id);
  db.update(workers).set({ userId: aishaUser.id, email: 'aisha@riverside.local' }).where(eq(workers.id, aisha.id)).run();

  // ---------- Relationships ----------
  db.insert(orgRelationships).values({ id: newId('rel'), orgId: oakwood.id, otherOrgId: riverside.id, kind: RelationshipKind.PREFERRED, note: 'Long-standing partner; staff know Oakwood Manor well.', createdAt: now }).run();

  // ---------- Capacity flags ----------
  const settings = getSettings(db);
  createFlag(db, settings, { orgId: riverside.id, kind: CapacityFlagKind.SURPLUS, jobRole: 'CARE_ASSISTANT', headcount: 3, hoursRequested: 60, startsAt: now, endsAt: addDays(now, 14), postcodeAreas: ['M', 'SK'], note: 'Occupancy down after two discharges; three care assistants short of hours.', createdByUserId: rivAdmin.id }, addHours(now, -30));
  createFlag(db, settings, { orgId: bright.id, kind: CapacityFlagKind.SURPLUS, jobRole: 'SUPPORT_WORKER', headcount: 2, hoursRequested: 24, startsAt: now, endsAt: addDays(now, 10), radiusKm: 20, note: 'Two support workers available for day shifts.' }, addHours(now, -6));
  createFlag(db, settings, { orgId: oakwood.id, kind: CapacityFlagKind.SHORTAGE, jobRole: 'CARE_ASSISTANT', headcount: 2, hoursRequested: 80, startsAt: now, endsAt: addDays(now, 14), note: 'Two vacancies plus sickness at Oakwood Manor.', createdByUserId: oakAdmin.id }, addHours(now, -20));
  createFlag(db, settings, { orgId: pennine.id, kind: CapacityFlagKind.SHORTAGE, jobRole: 'NURSE', headcount: 1, hoursRequested: 36, startsAt: now, endsAt: addDays(now, 21), note: 'Night nurse on long-term sick.', createdByUserId: penAdmin.id }, addHours(now, -2));

  // ---------- Shifts ----------
  const day = (d: number, h: number) => {
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + d, h, 0, 0));
    return t;
  };
  const posted: Shift[] = [];
  const post = (hostOrgId: string, s: Site, createdBy: string, data: Partial<Shift> & { jobRole: JobRole; title: string; startsAt: Date; endsAt: Date; chargeRate: number }, publishedAt = now) => {
    const id = newId('shf');
    db.insert(shifts)
      .values({ id, hostOrgId, siteId: s.id, breakMinutes: 30, headcount: 1, requiredSkills: ['MOVING_AND_HANDLING'], extraRequiredDocuments: [], currency: 'GBP', visibility: ShiftVisibility.NETWORK, autoConfirm: false, status: 'DRAFT', urgent: false, createdByUserId: createdBy, createdAt: publishedAt, updatedAt: publishedAt, ...data })
      .run();
    const shift = db.select().from(shifts).where(eq(shifts.id, id)).get()!;
    const published = publishShift(db, notifier, settings, shift, s, publishedAt);
    posted.push(published);
    return published;
  };

  const s1 = post(oakwood.id, oakManor, oakAdmin.id, { jobRole: 'CARE_ASSISTANT', title: 'Day shift – Maple unit', description: 'Dementia unit, 18 residents. Two hoisted residents.', startsAt: day(2, 7), endsAt: day(2, 19), breakMinutes: 60, chargeRate: 18, requiredSkills: ['MOVING_AND_HANDLING', 'DEMENTIA'] }, addHours(now, -3));
  post(oakwood.id, oakManor, oakAdmin.id, { jobRole: 'CARE_ASSISTANT', title: 'Night shift – Maple unit', startsAt: day(2, 19), endsAt: day(3, 7), breakMinutes: 60, chargeRate: 19.5, headcount: 2, requiredSkills: ['MOVING_AND_HANDLING', 'DEMENTIA'] }, addHours(now, -1));
  post(oakwood.id, oakLodge, oakAdmin.id, { jobRole: 'SENIOR_CARER', title: 'Senior – weekend early', startsAt: day(4, 7), endsAt: day(4, 14), chargeRate: 21, requiredSkills: ['MOVING_AND_HANDLING', 'MEDICATION'] });
  post(oakwood.id, oakLodge, oakAdmin.id, { jobRole: 'CARE_ASSISTANT', title: 'Urgent: late shift cover', description: 'Sickness cover. Please arrive 15 minutes early for handover.', startsAt: addHours(now, 5), endsAt: addHours(now, 13), chargeRate: 22 });
  post(pennine.id, penSite, penAdmin.id, { jobRole: 'NURSE', title: 'RGN night – Pennine View', description: 'Medication round, one PEG-fed resident, syringe driver in place.', startsAt: day(3, 19), endsAt: day(4, 7), breakMinutes: 60, chargeRate: 34, requiredSkills: ['MOVING_AND_HANDLING', 'MEDICATION', 'PEG_FEEDING'] });
  post(pennine.id, penSite, penAdmin.id, { jobRole: 'NURSE', title: 'RGN day – Pennine View', startsAt: day(5, 7), endsAt: day(5, 19), breakMinutes: 60, chargeRate: 32, requiredSkills: ['MOVING_AND_HANDLING', 'MEDICATION'] });
  post(bright.id, db.select().from(sites).where(eq(sites.orgId, bright.id)).get()!, oakAdmin.id, { jobRole: 'SUPPORT_WORKER', title: 'Community support – driver needed', startsAt: day(6, 9), endsAt: day(6, 17), chargeRate: 17, requiredSkills: ['MOVING_AND_HANDLING', 'DRIVER'], visibility: ShiftVisibility.NETWORK });

  // Riverside (priority) has already put Aisha forward for the Maple day shift; Oakwood confirmed it.
  const oakManorSite = db.select().from(sites).where(eq(sites.id, s1.siteId)).get()!;
  const { assignment } = requestShift(db, notifier, settings, s1, oakManorSite, aisha, { userId: rivAdmin.id, orgId: riverside.id }, {}, addHours(now, -2));
  confirmAssignment(db, notifier, settings, assignment, { userId: oakAdmin.id, orgId: oakwood.id }, addHours(now, -1));
  // Connor is waiting for a decision on the night shift.
  const night = posted[1]!;
  requestShift(db, notifier, settings, night, oakManorSite, rivWorkers[1]!, { userId: rivAdmin.id, orgId: riverside.id }, { note: 'Connor has covered Maple nights before.' }, addHours(now, -0.5));

  sqlite.close();
  console.log(`Seeded ${config.databaseUrl}\n`);
  console.log('Log in with any of these (password: password123):');
  console.log('  admin@merge.local           platform admin (Merge Staffing – agency)');
  console.log('  bank@merge.local            agency bank manager');
  console.log('  admin@oakwood.local         Oakwood Care Homes (short-staffed, posting shifts)');
  console.log('  admin@riverside.local       Riverside Living (surplus flag → priority access)');
  console.log('  admin@brighthorizons.local  Bright Horizons Support (surplus support workers)');
  console.log('  admin@pennine.local         Pennine Nursing (nurse shortage)');
  console.log('  aisha@riverside.local       a care worker with self-service enabled');
}

function org(db: Db, now: Date, data: Partial<typeof organisations.$inferInsert> & { name: string; type: OrgType }) {
  const id = newId('org');
  db.insert(organisations).values({ id, status: 'ACTIVE', serviceTypes: [], createdAt: now, updatedAt: now, ...data }).run();
  return db.select().from(organisations).where(eq(organisations.id, id)).get()!;
}

async function user(db: Db, now: Date, passwordHash: string, orgId: string, email: string, firstName: string, lastName: string, role: UserRole, workerId: string | null = null) {
  const id = newId('usr');
  db.insert(users).values({ id, orgId, email, passwordHash, firstName, lastName, role, workerId, status: 'ACTIVE', createdAt: now }).run();
  return db.select().from(users).where(eq(users.id, id)).get()!;
}

function site(db: Db, now: Date, orgId: string, data: Omit<typeof sites.$inferInsert, 'id' | 'orgId' | 'createdAt'>) {
  const id = newId('site');
  db.insert(sites).values({ id, orgId, createdAt: now, ...data }).run();
  return db.select().from(sites).where(eq(sites.id, id)).get()!;
}

function worker(db: Db, now: Date, orgId: string, firstName: string, lastName: string, jobRole: JobRole, skills: Skill[], postcode: string, lat: number, lng: number, travelRadiusKm: number, hourlyPayRate = 12.5): Worker {
  const id = newId('wrk');
  db.insert(workers).values({ id, orgId, firstName, lastName, jobRole, skills, status: 'ACTIVE', shareable: true, contractedHoursPerWeek: 30, maxHoursPerWeek: 48, optedOutOf48h: false, postcode, lat, lng, travelRadiusKm, hourlyPayRate, createdAt: now, updatedAt: now }).run();
  return db.select().from(workers).where(eq(workers.id, id)).get()!;
}

function document(db: Db, now: Date, workerId: string, type: DocumentType, expiresAt: Date, verifiedAt: Date | null, verifiedBy: string) {
  db.insert(workerDocuments).values({ id: newId('doc'), workerId, type, reference: `${type.slice(0, 3)}-${Math.floor(Math.random() * 900000 + 100000)}`, issuedAt: addDays(now, -200), expiresAt, verifiedAt, verifiedByUserId: verifiedAt ? verifiedBy : null, createdAt: now }).run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
