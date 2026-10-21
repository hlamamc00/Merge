import { round2 } from './time.js';

export interface ShiftFinancialsInput {
  /** What the host organisation pays per hour for the shift. */
  chargeRate: number;
  /** Paid hours (after unpaid breaks). */
  hours: number;
  /** Platform commission taken from the charge, as a percentage (e.g. 8 for 8%). */
  platformFeePct: number;
}

export interface ShiftFinancials {
  hostCost: number;
  platformFee: number;
  supplierReceives: number;
}

/**
 * Money flow for a filled shift:
 *   host pays chargeRate × hours
 *   platform keeps platformFeePct of that
 *   the supplying organisation (the worker's employer) receives the remainder and pays its worker under its own contract.
 */
export function computeShiftFinancials(input: ShiftFinancialsInput): ShiftFinancials {
  const hostCost = round2(input.chargeRate * input.hours);
  const platformFee = round2((hostCost * input.platformFeePct) / 100);
  const supplierReceives = round2(hostCost - platformFee);
  return { hostCost, platformFee, supplierReceives };
}
