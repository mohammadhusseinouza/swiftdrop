import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PackageSearch, Truck } from 'lucide-react';

import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { TextField } from '../../components/forms/Field';
import { LoadingState } from '../../components/feedback/LoadingState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { EmptyState } from '../../components/feedback/EmptyState';
import { CustomerOrderTimeline } from '../../components/customer/CustomerOrderTimeline';
import { formatDate } from '../../lib/format';
import {
  getApiErrorStatus,
  isTransportError,
} from '../../services/apiError';
import { useGetPublicTrackingQuery } from '../../services/trackingApi';

/**
 * Public Tracking (Phase 14.1) — unauthenticated, read-only.
 *
 * The submitted tracking code lives in the URL (`?code=`) as the single
 * source of truth: a deep refresh re-runs the same lookup, and the RTK Query
 * cache key naturally changes with it. No Redux slice, no second fetch
 * layer — this page's only server-state dependency is
 * `useGetPublicTrackingQuery` on the ONE shared `api` (task §26/§27).
 *
 * Server remains authoritative for the stage list — the timeline reuses
 * `CustomerOrderTimeline` as-is (task §22): that component only reads
 * `stages` / `exception`, both already part of the narrower public DTO, so
 * no Customer-specific field or styling dependency is introduced.
 */
export default function PublicTrackingPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const submittedCode = searchParams.get('code')?.trim() || '';

  const [inputValue, setInputValue] = useState(submittedCode);
  const [formError, setFormError] = useState<string | null>(null);

  // Keep the input in sync when the URL changes from outside this form (deep
  // link / browser back-forward) without clobbering what the user is typing.
  useEffect(() => {
    setInputValue(submittedCode);
  }, [submittedCode]);

  const { data, isFetching, isError, error, refetch } =
    useGetPublicTrackingQuery(submittedCode, { skip: !submittedCode });

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = inputValue.trim();
    if (!trimmed) {
      setFormError('Enter a tracking number.');
      return;
    }
    setFormError(null);
    setSearchParams({ code: trimmed });
  }

  const status = getApiErrorStatus(error);
  const isNotFound = isError && status === 404;
  const isOtherError = isError && !isNotFound;

  const currentStageLabel = data
    ? data.isDelivered
      ? 'Delivered'
      : (data.exception?.message ??
        data.stages.find((s) => s.state === 'current')?.label ??
        data.stages[0]?.label ??
        'Order Received')
    : null;

  return (
    <div className="w-full max-w-md">
      <div className="mb-6 flex items-center justify-center gap-2.5">
        <span
          className="flex size-9 items-center justify-center rounded-control bg-brand-600 text-white"
          aria-hidden="true"
        >
          <Truck className="size-5" />
        </span>
        <span className="text-lg font-semibold tracking-tight text-ink">
          SwiftDrop
        </span>
      </div>

      <Card>
        <h1 className="text-xl font-semibold text-ink">Track Your Order</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Enter your tracking number to see its delivery progress.
        </p>

        <form onSubmit={handleSubmit} noValidate className="mt-5 space-y-3">
          <TextField
            label="Tracking number"
            placeholder="TRK-XXXXXXXX"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              if (formError) setFormError(null);
            }}
            error={formError}
          />
          <Button type="submit" loading={isFetching} className="w-full">
            Track Order
          </Button>
        </form>
      </Card>

      {submittedCode && (
        <Card className="mt-4">
          {isFetching && <LoadingState label="Tracking your order…" />}

          {!isFetching && isNotFound && (
            <EmptyState
              icon={<PackageSearch />}
              title="Tracking number not found."
              description="Check the tracking number and try again."
            />
          )}

          {!isFetching && isOtherError && (
            <ErrorState
              message={
                isTransportError(error)
                  ? 'Unable to reach the server. Please try again.'
                  : 'Something went wrong while tracking your order. Please try again.'
              }
              onRetry={refetch}
            />
          )}

          {!isFetching && !isError && data && (
            <div className="space-y-5">
              <div>
                <p className="text-xs font-medium tracking-wide text-ink-subtle uppercase">
                  Tracking {data.trackingCode}
                </p>
                <p className="mt-1 text-lg font-semibold text-ink">
                  {currentStageLabel}
                </p>
                {data.isDelivered && data.deliveredAt && (
                  <p className="mt-0.5 text-sm text-ink-muted">
                    Delivered on {formatDate(data.deliveredAt)}
                  </p>
                )}
              </div>

              <div>
                <h2 className="mb-3 text-sm font-semibold text-ink">
                  Progress Timeline
                </h2>
                <CustomerOrderTimeline tracking={data} />
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
