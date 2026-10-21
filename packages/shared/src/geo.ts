/** Great-circle distance between two points in kilometres. */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * The "area" part of a UK postcode: the leading letters, e.g. "M1 2AB" → "M", "SW1A 1AA" → "SW".
 * Used for coarse geographic matching of capacity flags when coordinates are unavailable.
 */
export function postcodeArea(postcode: string | null | undefined): string | null {
  if (!postcode) return null;
  const m = postcode.trim().toUpperCase().match(/^([A-Z]{1,2})/);
  return m?.[1] ?? null;
}

/** The outward code of a UK postcode: "SW1A 1AA" → "SW1A". */
export function postcodeOutward(postcode: string | null | undefined): string | null {
  if (!postcode) return null;
  const cleaned = postcode.trim().toUpperCase().replace(/\s+/g, '');
  if (cleaned.length < 5) return cleaned || null;
  return cleaned.slice(0, cleaned.length - 3);
}
