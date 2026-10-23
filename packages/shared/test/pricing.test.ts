import { describe, expect, it } from 'vitest';
import { floorChargeRate } from '../src/index.js';

describe('floorChargeRate', () => {
  it('covers wage, on-costs and the platform fee, rounded up to 5p', () => {
    // 12.71 × 1.25 = 15.8875; ÷ 0.92 = 17.269 → 17.30
    expect(floorChargeRate({ minimumWage: 12.71, employerOnCostPct: 25, platformFeePct: 8 })).toBe(17.3);
    expect(floorChargeRate({ minimumWage: 12.71, employerOnCostPct: 0, platformFeePct: 0 })).toBe(12.75);
    expect(floorChargeRate({ minimumWage: 10, employerOnCostPct: 20, platformFeePct: 20 })).toBe(15);
  });
});
