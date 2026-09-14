import { Wallet, Hourglass, PackageOpen, PackageCheck } from 'lucide-react';

import { useGetCustomerDashboardQuery } from '../../services/customerDashboardApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';
import { formatMoney } from '../../lib/format';

import { PageHeader } from '../../components/data-display/PageHeader';
import { StatisticCard } from '../../components/data-display/StatisticCard';
import { Card } from '../../components/ui/Card';
import { LoadingState } from '../../components/feedback/LoadingState';
import { ErrorState } from '../../components/feedback/ErrorState';

/**
 * Phase 13.1 — /customer/dashboard.
 *
 * READ-ONLY overview of the authenticated Customer's own money and order
 * activity, straight from GET /api/v1/customer/me/dashboard. Four cards, exact
 * server values, no calculation in React (task §11/§39). Deliberately NOT
 * here (task §25/§29/§30): any Withdraw / Request Payout / adjust action,
 * Driver Cash, Company Revenue, financial-review status, Parcel Collection
 * internals — this phase is purely informational.
 */
export default function CustomerDashboardPage() {
  const query = useGetCustomerDashboardQuery();
  const data = query.data;

  const greetingName = data?.customer.name?.trim();

  return (
    <div className="space-y-5">
      <PageHeader
        size="lg"
        title="Dashboard"
        description={
          greetingName
            ? `Welcome back, ${greetingName}.`
            : 'Your wallet balance and order activity at a glance.'
        }
      />

      {query.isLoading ? (
        <Card flush>
          <LoadingState className="py-16" label="Loading your dashboard…" />
        </Card>
      ) : query.isError ? (
        <Card flush>
          <ErrorState
            className="py-16"
            message={getApiErrorMessage(query.error as UnknownApiError)}
            onRetry={() => void query.refetch()}
          />
        </Card>
      ) : data ? (
        <section
          aria-label="Account summary"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
        >
          <StatisticCard
            icon={Wallet}
            label="Available Wallet"
            value={formatMoney(data.availableWalletBalance, { fallback: '$0.00' })}
            supportingText="Available to be paid out by the company."
          />
          <StatisticCard
            icon={Hourglass}
            label="Pending Amount"
            value={formatMoney(data.pendingAmount, { fallback: '$0.00' })}
            supportingText="Potential Customer money from active Delivery Only orders. Not yet available."
          />
          <StatisticCard
            icon={PackageOpen}
            label="Active Orders"
            value={data.activeOrders}
            supportingText="Orders still in progress."
          />
          <StatisticCard
            icon={PackageCheck}
            label="Delivered Orders"
            value={data.deliveredOrders}
            supportingText="Orders delivered to the receiver."
          />
        </section>
      ) : null}
    </div>
  );
}
