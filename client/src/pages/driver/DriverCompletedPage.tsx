import { DriverHistoryPage } from './DriverHistoryPage';

/**
 * Phase 12.5 — /driver/completed. Read-only history of this Driver's own
 * successfully completed COLLECTION and DELIVERY work (task §26). A Collection
 * counts as completed only once Management has confirmed company receipt.
 */
export default function DriverCompletedPage() {
  return (
    <DriverHistoryPage
      result="COMPLETED"
      title="Completed"
      description="Your finished Collection and Delivery jobs."
      emptyTitle="No completed jobs yet."
      summaryNoun="completed"
    />
  );
}
