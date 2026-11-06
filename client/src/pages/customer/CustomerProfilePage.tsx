import type { ReactNode } from 'react';
import { UserRound } from 'lucide-react';

import { useGetCustomerProfileQuery } from '../../services/customerProfileApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';
import type { CustomerProfile } from '../../services/domain.types';

import { LoadingState } from '../../components/feedback/LoadingState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { DetailPanel } from '../../components/customer/DetailPanel';
import { getProfileInitials, isMissingValue } from '../../components/customer/customerProfilePresentation';

/**
 * /customer/profile — Profile (Customer Portal Redesign Step 6, handoff §3.5).
 *
 * READ-ONLY basic customer information from GET /api/v1/customer/me/profile
 * (self-scoped — the Customer is the authenticated identity, never a client
 * id). Deliberately NO Edit Profile / change-password / any mutation control:
 * the helper copy tells the customer to contact Spring Delivery instead.
 * Missing optional values render "—".
 */
const PANEL = 'rounded-panel border border-line bg-card';

export default function CustomerProfilePage() {
  const query = useGetCustomerProfileQuery();
  const data = query.data;

  return (
    <div className="mx-auto flex w-full max-w-[960px] flex-col gap-6">
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
          <IdentityPanel data={data} />
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))] gap-5">
            <DetailPanel title="Contact">
              <dl className="-my-3 divide-y divide-line-subtle">
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
                      className="font-semibold text-brand-600 hover:text-brand-700 hover:underline"
                    >
                      {data.email}
                    </a>
                  )}
                </Row>
              </dl>
            </DetailPanel>

            <DetailPanel title="Default pickup details">
              <dl className="-my-3 divide-y divide-line-subtle">
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

function IdentityPanel({ data }: { data: CustomerProfile }) {
  const initials = getProfileInitials(data.name);
  return (
    <section aria-label="Your details" className={`${PANEL} flex flex-wrap items-center gap-6 p-6 sm:p-8`}>
      <span
        className="flex size-[84px] shrink-0 items-center justify-center rounded-[26px] bg-chrome text-[1.75rem] font-bold tracking-[-0.02em] text-white"
        aria-hidden="true"
      >
        {initials ?? <UserRound className="size-9 text-chrome-ink" strokeWidth={2} />}
      </span>
      <div className="min-w-0 flex-[1_1_260px]">
        <h1 className="text-[1.75rem] leading-[1.1] font-bold tracking-[-0.03em] text-ink [overflow-wrap:anywhere] sm:text-[2.125rem]">
          {isMissingValue(data.name) ? 'Your profile' : data.name}
        </h1>
        <p className="mt-1.5 text-sm text-ink-secondary">
          Customer number <strong className="font-bold text-ink">{data.customerNumber}</strong>
        </p>
        <p className="mt-3 text-sm text-ink-muted">
          Need to change something? Contact Spring Delivery and we will update your details for you.
        </p>
      </div>
    </section>
  );
}

/** Label left / value right; long values wrap; missing values show "—". */
function Row({ label, children }: { label: string; children: ReactNode }) {
  const missing = children == null || children === false || children === '';
  return (
    <div className="flex items-baseline justify-between gap-6 py-3">
      <dt className="shrink-0 text-sm text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-semibold text-ink [overflow-wrap:anywhere]">
        {missing ? (
          <span className="font-normal text-ink-muted">
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
      className="font-semibold text-brand-600 hover:text-brand-700 hover:underline"
    >
      {phone}
    </a>
  );
}
