/** Decision 3: the lowest charge rate a host may post. */
export interface FloorRateInput {
  /** Hourly minimum wage payable to the worker. */
  minimumWage: number;
  /** Employer on-costs (National Insurance, pension, holiday pay) as a percentage of wages. */
  employerOnCostPct: number;
  /** Platform fee as a percentage of the charge. */
  platformFeePct: number;
}

/**
 * floor = minimum wage × (1 + on-cost %) ÷ (1 − platform fee %), rounded UP to the nearest 5p,
 * so the supplier receives at least what it costs to employ the worker after the platform fee.
 */
export function floorChargeRate(input: FloorRateInput): number {
  const fee = Math.min(Math.max(input.platformFeePct, 0), 99) / 100;
  const raw = (input.minimumWage * (1 + Math.max(input.employerOnCostPct, 0) / 100)) / (1 - fee);
  return Math.ceil(raw * 20 - 1e-9) / 20;
}
