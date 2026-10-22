import { requiredDocumentsForRole, type Skill } from '@merge/shared';
import { AREAS, iso, personName, postcodeNear } from './lib.js';
import type { SimContext } from './scenario.js';

/** The agency hires more bank workers mid-run. */
export async function addBankWorkers(ctx: SimContext, count: number): Promise<void> {
  const { api, rng, world, clock, log } = ctx;
  const org = world.agency;
  for (let i = 0; i < count; i++) {
    const name = personName(rng);
    const pc = postcodeNear(rng, rng.pick(AREAS));
    const jobRole = rng.pick(['CARE_ASSISTANT', 'CARE_ASSISTANT', 'SENIOR_CARER', 'NURSE'] as const);
    const skills: Skill[] = ['MOVING_AND_HANDLING', 'DEMENTIA', ...(jobRole === 'CARE_ASSISTANT' ? [] : (['MEDICATION'] as Skill[]))];
    const w = await api.task('Add a worker', 'agency bank manager', () => api.post('/api/v1/workers', org.adminToken, { firstName: name.firstName, lastName: name.lastName, jobRole, skills, shareable: true, contractedHoursPerWeek: 0, maxHoursPerWeek: 48, postcode: pc.postcode, lat: pc.lat, lng: pc.lng, travelRadiusKm: 30, hourlyPayRate: 13 }));
    api.countTask('Add a worker');
    for (const type of requiredDocumentsForRole(jobRole)) {
      const doc = await api.task('Add a worker document', 'agency bank manager', () => api.post(`/api/v1/workers/${w.body.id}/documents`, org.adminToken, { type, reference: `${type.slice(0, 3)}-${rng.int(100000, 999999)}`, expiresAt: iso(clock.plusDays(rng.int(300, 900))) }));
      api.countTask('Add a worker document');
      await api.task('Verify a worker document', 'agency bank manager', () => api.patch(`/api/v1/workers/${w.body.id}/documents/${doc.body.id}`, org.adminToken, { verified: true }));
      api.countTask('Verify a worker document');
    }
    org.workers.push({ id: w.body.id, orgId: org.id, name: `${name.firstName} ${name.lastName}`, jobRole, group: jobRole === 'NURSE' ? 'NURSE' : jobRole === 'SENIOR_CARER' ? 'SENIOR' : 'CARE', skills, shareable: true, token: null, email: null, contractedHours: 0, active: true });
  }
  log(`${iso(clock.now).slice(0, 10)} agency bank grew by ${count} to ${org.workers.length}`);
}
