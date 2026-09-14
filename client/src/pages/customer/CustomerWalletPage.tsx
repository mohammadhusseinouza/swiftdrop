import { Wallet, Hourglass } from 'lucide-react';

import { useGetCustomerWalletQuery } from '../../services/customerWalletApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';
import { formatMoney } from '../../lib/format';

import { PageHeader } from '../../components/data-display/PageHeader';
import { StatisticCard } from '../../components/data-display/StatisticCard';
import { Card } from '../../components/ui/Card';
import { LoadingState } from '../../components/feedback/LoadingState';
import { ErrorState } from '../../components/feedback/ErrorState';

/**
 * Phase 13.4 — /customer/wallet.
 *
 * READ-ONLY wallet summary: Available Balance + Pending Amount, straight from
 * GET /api/v1/customer/me/wallet (the same authoritative figures as the
 * Dashboard). No transaction ledger (Phase 13.5), no payout history (Phase
 * 13.6), and deliberately NO Withdraw / Request Payout control — V1 payouts
 * are created by company staff (task §22 / §31).
 */
export default function CustomerWalletPage() {
  const query = useGetCustomerWalletQuery();
  const data = query.data;

  return (
    <div className="space-y-5">
      <PageHeader
        size="lg"
        title="Wallet"
        description="Money currently available for payout, and money still pending from active Delivery Only orders."
      />

      {query.isLoading ? (
        <Card flush>
          <LoadingState className="py-16" label="Loading your wallet…" />
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
        <>
          <section
            aria-label="Wallet balances"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          >
            <StatisticCard
              icon={Wallet}
              label="Available Balance"
              value={formatMoney(data.availableBalance, { fallback: '$0.00' })}
              supportingText="Available for payout by the company."
            />
            <StatisticCard
              icon={Hourglass}
              label="Pending Amount"
              value={formatMoney(data.pendingAmount, { fallback: '$0.00' })}
              supportingText="Potential Customer money from active Delivery Only orders. Not yet available."
            />
          </section>

          <Card>
            <h2 className="text-sm font-semibold text-ink">About these amounts</h2>
            <dl className="mt-3 space-y-3 text-sm">
              <div>
                <dt className="font-medium text-ink">Available Balance</dt>
                <dd className="mt-0.5 text-ink-muted">
                  Money from completed eligible Delivery Only orders that is
                  currently available for the company to pay out to you.
                </dd>
              </div>
              <div>
                <dt className="font-medium text-ink">Pending Amount</dt>
                <dd className="mt-0.5 text-ink-muted">
                  Potential money from your active Delivery Only orders. It
                  becomes available once those orders are delivered and
                  finalized. It is not yet available for payout.
                </dd>
              </div>
            </dl>
          </Card>
        </>
      )}
    </div>
  );
}
