import type { ReactNode } from 'react';

import { useGetCustomerProfileQuery } from '../../services/customerProfileApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';

import { PageHeader } from '../../components/data-display/PageHeader';
import { Card } from '../../components/ui/Card';
import { LoadingState } from '../../components/feedback/LoadingState';
import { ErrorState } from '../../components/feedback/ErrorState';

/**
 * Phase 13.7 — /customer/profile.
 *
 * READ-ONLY basic customer information, straight from
 * GET /api/v1/customer/me/profile (self-scoped — the Customer is the
 * authenticated identity, never a client id).
 *
 * The approved page structure says only "Display basic customer information"
 * and that editing "may be editable later" — so there is deliberately NO Edit
 * Profile button (not even a disabled one), no password / account-security
 * section, and no wallet / order / tracking data (those have their own
 * Customer pages). Optional fields render "Not provided" rather than a raw
 * null.
 */
export default function CustomerProfilePage() {
  const query = useGetCustomerProfileQuery();
  const data = query.data;

  return (
    <div className="space-y-5">
      <PageHeader size="lg" title="Profile" description="Your customer information." />

      {query.isLoading ? (
        <Card flush>
          <LoadingState className="py-16" label="Loading your profile…" />
        </Card>
      ) : query.isError || !data ? (
        <Card flush>
          <ErrorState
            className="py-16"
            message={getApiErrorMessage(query.error as UnknownApiError)}
            onRetry={() => void query.refetch()}
          />
        </Card>
      ) : (
        <div className="space-y-4">
          <ProfileSection title="Profile Information">
            <Field label="Name" value={data.name} />
            <Field label="Customer Number" value={data.customerNumber} />
          </ProfileSection>

          <ProfileSection title="Contact Information">
            <Field
              label="Primary Phone"
              value={<PhoneValue phone={data.primaryPhone} label="Primary phone" />}
            />
            <Field
              label="Secondary Phone"
              value={
                data.secondaryPhone ? (
                  <PhoneValue phone={data.secondaryPhone} label="Secondary phone" />
                ) : null
              }
            />
            <Field
              label="Email"
              value={
                data.email ? (
                  <a
                    href={`mailto:${data.email}`}
                    aria-label={`Email ${data.email}`}
                    className="text-brand-700 hover:underline"
                  >
                    {data.email}
                  </a>
                ) : null
              }
            />
          </ProfileSection>

          <ProfileSection title="Default Delivery Information">
            <Field label="Default Area" value={data.defaultArea?.name ?? null} />
            <Field label="Default Address" value={data.defaultAddress} />
          </ProfileSection>
        </div>
      )}
    </div>
  );
}

function ProfileSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">{children}</dl>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  const empty = value == null || value === '';
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd
        className={
          empty
            ? 'mt-0.5 text-sm italic text-ink-subtle'
            : 'mt-0.5 break-words text-sm text-ink'
        }
      >
        {empty ? 'Not provided' : value}
      </dd>
    </div>
  );
}

function PhoneValue({ phone, label }: { phone: string; label: string }) {
  return (
    <a
      href={`tel:${phone}`}
      aria-label={`${label} ${phone}`}
      className="text-brand-700 hover:underline"
    >
      {phone}
    </a>
  );
}
