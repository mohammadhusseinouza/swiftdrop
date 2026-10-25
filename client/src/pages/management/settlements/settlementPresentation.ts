import type { BadgeTone } from '../../../components/ui/Badge';
import { PERMISSIONS } from '../../../features/auth/permissions';
import type { SettlementSummary } from '../../../services/domain.types';
import type { SettlementDetail } from '../../../services/settlementsApi';
// Release / review / collection-state vocabulary is shared with the order,
// wallet and report screens (FR.10) — one source, re-exported here.
export {
  collectionStateLabel,
  releaseStatusLabel,
  reviewStatusLabel,
} from '../../../components/finance/financialRelease';
import type { AllocationRowStatus } from './settlementAllocation';

/**
 * FR.9 — display vocabulary for settlement allocation and settlement detail.
 * Pure (no React) so labels, tones and capability rules are unit-tested.
 */

export interface LabelTone {
  label: string;
  tone: BadgeTone;
}

export const ALLOCATION_ROW_STATUS: Record<AllocationRowStatus, LabelTone> = {
  WILL_RELEASE: { label: 'Will release', tone: 'success' },
  SETTLES_AWAITS_REVIEW: { label: 'Settles; awaits review', tone: 'warning' },
  PARTIAL: { label: 'Partial', tone: 'info' },
  INVALID: { label: 'Check amount', tone: 'danger' },
};

const CORRECTION_TYPE: Record<string, string> = {
  SETTLEMENT_REVERSAL: 'Settlement reversed',
  SETTLEMENT_SHORTFALL: 'Shortfall recorded',
};

function fallback(token: string): LabelTone {
  return { label: token.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase()), tone: 'neutral' };
}

export function correctionTypeLabel(type: string): string {
  return CORRECTION_TYPE[type] ?? fallback(type).label;
}

/** FR.10.2 — the financial state a recorded settlement correction leaves behind. */
export function correctionResultLabel(type: string): string {
  if (type === 'SETTLEMENT_REVERSAL') return 'settlement reversed — driver cash credited back, allocations reversed';
  if (type === 'SETTLEMENT_SHORTFALL') return 'driver obligation re-established as unattributed cash; released credits stand';
  return correctionTypeLabel(type);
}

/** A settlement recorded without allocations (all FR.4 fields null). */
export function isLegacySettlement(s: Pick<SettlementSummary, 'allocatedTotal'>): boolean {
  return s.allocatedTotal === null;
}

/* ------------------------------ capabilities ----------------------------- */

export interface SettlementCapabilities {
  canCreate: boolean;
  /** Cash position + outstanding collections are finance.read reads. */
  canReadFinance: boolean;
  /** Processing needs both: the dialog cannot show the cash position without finance.read. */
  canProcess: boolean;
  canViewOrders: boolean;
  canViewDriver: boolean;
  canViewCustomers: boolean;
}

export function settlementCapabilities(permissions: readonly string[]): SettlementCapabilities {
  const has = (p: string) => permissions.includes(p);
  const canCreate = has(PERMISSIONS.SETTLEMENTS_CREATE);
  const canReadFinance = has(PERMISSIONS.FINANCE_READ);
  return {
    canCreate,
    canReadFinance,
    canProcess: canCreate && canReadFinance,
    canViewOrders: has(PERMISSIONS.ORDERS_READ),
    canViewDriver: has(PERMISSIONS.DRIVERS_READ),
    canViewCustomers: has(PERMISSIONS.CUSTOMERS_READ),
  };
}

/* ------------------------------ detail summary --------------------------- */

export interface SettlementDetailSummary {
  isLegacy: boolean;
  activeAllocationCount: number;
  reversedAllocationCount: number;
  releasedCount: number;
  hasUnattributed: boolean;
  hasCorrections: boolean;
  /** Read-only notices shown above the allocation breakdown. */
  notices: string[];
}

export function describeSettlementDetail(detail: SettlementDetail): SettlementDetailSummary {
  const isLegacy = detail.format === 'LEGACY';
  const active = detail.allocations.filter((a) => a.status === 'ACTIVE').length;
  const reversed = detail.allocations.length - active;
  const unattributed = detail.unattributedAmount;
  const hasUnattributed = unattributed !== null && !/^0+(\.0+)?$/.test(unattributed);
  const notices: string[] = [];
  if (isLegacy) {
    notices.push('Legacy settlement — recorded without collection allocations. It reduced driver cash only and released no orders.');
  }
  if (detail.reversed) {
    notices.push('This settlement was reversed: the driver cash it removed was restored and its allocations were reversed.');
  }
  if (!/^0+(\.0+)?$/.test(detail.shortfallTotal)) {
    notices.push('A shortfall was recorded: the driver handed over less than this settlement recorded. Released customer credits stand.');
  }
  return {
    isLegacy,
    activeAllocationCount: active,
    reversedAllocationCount: reversed,
    releasedCount: detail.releasedOrders.length,
    hasUnattributed,
    hasCorrections: detail.corrections.length > 0,
    notices,
  };
}
