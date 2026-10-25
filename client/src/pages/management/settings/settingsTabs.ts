/**
 * Phase 11.16 — Settings tab model. One route (`/management/settings`),
 * URL-authoritative tab via `?tab=`. No Redux.
 */
export const SETTINGS_TABS = [
  { id: 'general', label: 'General' },
  { id: 'payment-methods', label: 'Payment Methods' },
  { id: 'delivery', label: 'Delivery Settings' },
  { id: 'failed-reasons', label: 'Failed Delivery Reasons' },
  { id: 'failed-collection-reasons', label: 'Failed Collection Reasons' },
  { id: 'areas', label: 'Areas' },
  { id: 'permissions', label: 'Users & Permissions' },
  // FR.11B — ADMIN role only (the backend gates by role, not permission).
  { id: 'financial-release', label: 'Financial Release', adminOnly: true },
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id'];

const TAB_IDS = SETTINGS_TABS.map((t) => t.id) as readonly string[];
export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'general';

const ADMIN_ONLY_TABS: readonly string[] = SETTINGS_TABS.filter((t) => 'adminOnly' in t && t.adminOnly).map((t) => t.id);

/** Tabs visible to a role. Admin-only tabs are hidden from other roles (UX only). */
export function visibleSettingsTabs(roleCode: string | null) {
  return SETTINGS_TABS.filter((t) => roleCode === 'ADMIN' || !ADMIN_ONLY_TABS.includes(t.id));
}

export function parseSettingsTab(raw: string | null, roleCode: string | null = null): SettingsTabId {
  if (!raw || !TAB_IDS.includes(raw)) return DEFAULT_SETTINGS_TAB;
  if (ADMIN_ONLY_TABS.includes(raw) && roleCode !== 'ADMIN') return DEFAULT_SETTINGS_TAB;
  return raw as SettingsTabId;
}
