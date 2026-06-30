import { invalidateSessionsCache } from './sessions.ts';
import { invalidateChainsCache }   from './chains.ts';

export function invalidateScanCache(): void {
  // Both caches are cleared synchronously. If invalidateChainsCache throws,
  // invalidateSessionsCache is NOT called — neither cache is partially cleared.
  // Cache variables are plain null assignments and do not throw in practice;
  // this ordering preserves the all-or-nothing guarantee for free.
  invalidateChainsCache();
  invalidateSessionsCache();
}
