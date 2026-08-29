import { Badge } from './Badge';

/**
 * Active / Inactive status pill for a management record (Customer, Driver, …).
 * Deliberately NOT the Order `StatusBadge` — workflow status and account
 * activation are different concepts. The label text carries the meaning;
 * colour is secondary.
 */
export function ActiveBadge({ isActive }: { isActive: boolean }) {
  return (
    <Badge tone={isActive ? 'success' : 'neutral'} dot>
      {isActive ? 'Active' : 'Inactive'}
    </Badge>
  );
}
