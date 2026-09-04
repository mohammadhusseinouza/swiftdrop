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
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id'];

const TAB_IDS = SETTINGS_TABS.map((t) => t.id) as readonly string[];
export const DEFAULT_SETTINGS_TAB: SettingsTabId = 'general';

export function parseSettingsTab(raw: string | null): SettingsTabId {
  return raw && TAB_IDS.includes(raw)
    ? (raw as SettingsTabId)
    : DEFAULT_SETTINGS_TAB;
}
