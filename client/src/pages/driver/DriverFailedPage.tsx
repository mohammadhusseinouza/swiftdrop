import { DriverHistoryPage } from './DriverHistoryPage';

/**
 * Phase 12.5 — /driver/failed. Read-only history of this Driver's own failed
 * COLLECTION and DELIVERY attempts (task §29). Purely historical: a later
 * Management reschedule / reassignment / return never rewrites the Driver's
 * attempt — the row stays FAILED, with the Order's current state shown as
 * secondary context. No mutation buttons.
 */
export default function DriverFailedPage() {
  return (
    <DriverHistoryPage
      result="FAILED"
      title="Failed / Returned"
      description="Your failed Collection and Delivery attempts."
      emptyTitle="No failed jobs."
      summaryNoun="failed"
    />
  );
}
