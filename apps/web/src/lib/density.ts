/** The density setting (KF-SAS-RQ-276): presentation only, and every view usable at compact. */
export const DENSITY_COOKIE = 'kf_density';
export type Density = 'comfortable' | 'compact';

export function parseDensity(value: unknown): Density {
  return value === 'compact' ? 'compact' : 'comfortable';
}
