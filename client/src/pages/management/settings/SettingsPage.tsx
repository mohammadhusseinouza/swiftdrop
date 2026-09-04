import { useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

import { PageHeader } from '../../../components/data-display/PageHeader';
import {
  SETTINGS_TABS,
  parseSettingsTab,
  type SettingsTabId,
} from './settingsTabs';
import { GeneralTab } from './GeneralTab';
import { DeliveryTab } from './DeliveryTab';
import { PaymentMethodsTab } from './PaymentMethodsTab';
import { FailedReasonsTab } from './FailedReasonsTab';
import { FailedCollectionReasonsTab } from './FailedCollectionReasonsTab';
import { AreasTab } from './AreasTab';
import { RolePermissionsTab } from './RolePermissionsTab';

/**
 * Phase 11.16 — Management Settings. One route, URL-authoritative tab via
 * `?tab=`. Route guard is `settings.read`; every mutation control inside a
 * tab is gated on the hydrated `settings.manage` permission (backend is
 * authoritative). No Redux for tab / filter state.
 */
export default function SettingsPage() {
  const [sp, setSp] = useSearchParams();
  const tab = parseSettingsTab(sp.get('tab'));
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const selectTab = useCallback(
    (next: SettingsTabId) => {
      setSp((prev) => {
        const p = new URLSearchParams(prev);
        p.set('tab', next);
        // Drop tab-scoped params so a stale Areas filter / selected role does
        // not silently affect another tab.
        for (const k of ['areaSearch', 'areaStatus', 'areaPage', 'role']) {
          p.delete(k);
        }
        return p;
      });
    },
    [setSp],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = SETTINGS_TABS.findIndex((t) => t.id === tab);
    let nextIdx: number | null = null;
    if (e.key === 'ArrowRight') nextIdx = (idx + 1) % SETTINGS_TABS.length;
    if (e.key === 'ArrowLeft')
      nextIdx = (idx - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
    if (e.key === 'Home') nextIdx = 0;
    if (e.key === 'End') nextIdx = SETTINGS_TABS.length - 1;
    if (nextIdx !== null) {
      e.preventDefault();
      const nextTab = SETTINGS_TABS[nextIdx].id;
      selectTab(nextTab);
      tabRefs.current[nextTab]?.focus();
    }
  };

  const panel = useMemo(() => {
    switch (tab) {
      case 'general':
        return <GeneralTab />;
      case 'payment-methods':
        return <PaymentMethodsTab />;
      case 'delivery':
        return <DeliveryTab />;
      case 'failed-reasons':
        return <FailedReasonsTab />;
      case 'failed-collection-reasons':
        return <FailedCollectionReasonsTab />;
      case 'areas':
        return <AreasTab />;
      case 'permissions':
        return <RolePermissionsTab />;
    }
  }, [tab]);

  return (
    <div className="space-y-5">
      <PageHeader
        size="lg"
        title="Settings"
        description="Manage reference data, system configuration, and role-based access."
      />

      <div className="overflow-x-auto border-b border-line">
        <div
          role="tablist"
          aria-label="Settings sections"
          onKeyDown={onKeyDown}
          className="flex min-w-max gap-1"
        >
          {SETTINGS_TABS.map((t) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[t.id] = el;
                }}
                role="tab"
                id={`settings-tab-${t.id}`}
                aria-selected={active}
                aria-controls="settings-tabpanel"
                tabIndex={active ? 0 : -1}
                onClick={() => selectTab(t.id)}
                className={
                  'whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ' +
                  (active
                    ? 'border-brand-600 text-brand-700'
                    : 'border-transparent text-ink-muted hover:text-ink')
                }
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        id="settings-tabpanel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${tab}`}
      >
        {panel}
      </div>
    </div>
  );
}
