import type { ReactNode } from 'react';
import { UserRound } from 'lucide-react';

import { useGetCustomerProfileQuery } from '../../services/customerProfileApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';
import type { CustomerProfile } from '../../services/domain.types';

import { LoadingState } from '../../components/feedback/LoadingState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { DetailPanel } from '../../components/customer/DetailPanel';
import { CustomerHero } from '../../components/customer/CustomerHero';
import { getProfileInitials, isMissingValue } from '../../components/customer/customerProfilePresentation';

/**
 * /customer/profile — Profile (Customer Portal Redesign Step 6, handoff §3.5).
 *
 * READ-ONLY basic customer information from GET /api/v1/customer/me/profile
 * (self-scoped — the Customer is the authenticated identity, never a client
 * id). Deliberately NO Edit Profile / change-password / any mutation control:
 * the helper copy tells the customer to contact Spring Delivery instead.
 * Missing optional values render "—".
 *
 * Brand look (docs/brand-theme/brand-theme-handoff.md §4.5): the identity —
 * red initials tile (generic icon when the name is empty), name as H1,
 * customer number and helper copy — lives in the 960 px hero band. While the
 * profile loads or fails, the hero shows only the "Profile" eyebrow.
 */
const PANEL = 'rounded-2xl border border-sd-line bg-card shadow-sd-card';
const EYEBROW = 'font-sd-display text-[0.8125rem] font-semibold uppercase tracking-[0.16em] text-sd-on-dark';

export default function CustomerProfilePage() {
  const query = useGetCustomerProfileQuery();
  const data = query.data;

  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-6">
      <CustomerHero width="narrow">
        {data ? <IdentityHero data={data} /> : <p className={EYEBROW}>Profile</p>}
      </CustomerHero>
      {query.isLoading ? (
        <div className={PANEL}>
          <LoadingState className="py-16" label="Loading your profile…" />
        </div>
      ) : query.isError || !data ? (
        <div className={PANEL}>
          <ErrorState
            className="py-16"
            message={getApiErrorMessage(query.error as UnknownApiError)}
            onRetry={() => void query.refetch()}
          />
        </div>
      ) : (
        <>
          <div className="sd-stagger grid grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))] gap-5">
            <DetailPanel title="Contact" tone="brand">
              <dl className="-my-3 divide-y divide-sd-line-subtle">
                <Row label="Primary phone">
                  <PhoneValue phone={data.primaryPhone} label="Primary phone" />
                </Row>
                <Row label="Secondary phone">
                  {isMissingValue(data.secondaryPhone) ? null : (
                    <PhoneValue phone={data.secondaryPhone as string} label="Secondary phone" />
                  )}
                </Row>
                <Row label="Email">
                  {isMissingValue(data.email) ? null : (
                    <a
                      href={`mailto:${data.email}`}
                      aria-label={`Email ${data.email}`}
                      className="font-semibold text-sd-red-text hover:text-sd-red-hover hover:underline"
                    >
                      {data.email}
                    </a>
                  )}
                </Row>
              </dl>
            </DetailPanel>

            <DetailPanel title="Default pickup details" tone="brand">
              <dl className="-my-3 divide-y divide-sd-line-subtle">
                <Row label="Default area">{isMissingValue(data.defaultArea?.name) ? null : data.defaultArea?.name}</Row>
                <Row label="Default address">{isMissingValue(data.defaultAddress) ? null : data.defaultAddress}</Row>
              </dl>
            </DetailPanel>
          </div>
        </>
      )}
    </div>
  );
}

function IdentityHero({ data }: { data: CustomerProfile }) {
  const initials = getProfileInitials(data.name);
  return (
    <section aria-label="Your details" className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
      <div className="flex min-w-0 flex-[1_1_320px] flex-wrap items-center gap-5">
        <span
          className="flex size-[76px] shrink-0 items-center justify-center rounded-[18px] bg-sd-red font-sd-display text-[1.875rem] font-bold text-white shadow-sd-red"
          aria-hidden="true"
        >
          {initials ?? <UserRound className="size-8 text-sd-red-on" strokeWidth={2} />}
        </span>
        <div className="min-w-0 flex-[1_1_200px]">
          <p className={EYEBROW}>Profile</p>
          <h1 className="mt-2 font-sd-display text-[1.875rem] leading-[1.02] font-bold tracking-[-0.02em] text-white [overflow-wrap:anywhere] sm:text-[2.625rem]">
            {isMissingValue(data.name) ? 'Your profile' : data.name}
          </h1>
          <p className="mt-2 text-sm text-sd-on-dark">
            Customer number <strong className="font-bold text-white">{data.customerNumber}</strong>
          </p>
        </div>
      </div>
      <p className="max-w-xs text-sm text-sd-on-dark">
        Need to change something? Contact Spring Delivery and we will update your details for you.
      </p>
    </section>
  );
}

/** Label left / value right; long values wrap; missing values show "—". */
function Row({ label, children }: { label: string; children: ReactNode }) {
  const missing = children == null || children === false || children === '';
  return (
    <div className="flex items-baseline justify-between gap-6 py-3">
      <dt className="shrink-0 text-sm text-sd-text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-semibold text-sd-ink [overflow-wrap:anywhere]">
        {missing ? (
          <span className="font-normal text-sd-text-muted">
            <span aria-hidden="true">—</span>
            <span className="sr-only">Not provided</span>
          </span>
        ) : (
          children
        )}
      </dd>
    </div>
  );
}

function PhoneValue({ phone, label }: { phone: string; label: string }) {
  return (
    <a
      href={`tel:${phone}`}
      aria-label={`${label} ${phone}`}
      className="font-semibold text-sd-red-text hover:text-sd-red-hover hover:underline"
    >
      {phone}
    </a>
  );
}
