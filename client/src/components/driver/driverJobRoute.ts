import type { DriverJobType } from '../../services/domain.types';

/**
 * Safe URL-form <-> domain mapping for the Job Detail route (Phase 12.2,
 * task §41). The ONE place this translation happens on the frontend —
 * components build links with `toDriverJobRouteSegment`, the detail page
 * parses the URL with `parseDriverJobTypeParam`. Mirrors the backend's
 * DriverJobTypeParamSchema (server/src/modules/driver-jobs/driver-job.schema.ts)
 * exactly: lowercase in the URL, uppercase in the domain model.
 */
export function toDriverJobRouteSegment(jobType: DriverJobType): 'collection' | 'delivery' {
  return jobType === 'COLLECTION' ? 'collection' : 'delivery';
}

/** Returns the domain job type for a valid URL segment, or `null` for anything else. */
export function parseDriverJobTypeParam(raw: string | undefined): DriverJobType | null {
  if (raw === 'collection') return 'COLLECTION';
  if (raw === 'delivery') return 'DELIVERY';
  return null;
}
