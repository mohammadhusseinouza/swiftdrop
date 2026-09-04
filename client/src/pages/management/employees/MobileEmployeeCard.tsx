import { Link } from 'react-router-dom';

import { Badge } from '../../../components/ui/Badge';
import { ActiveBadge } from '../../../components/ui/ActiveBadge';
import { paths } from '../../../routes/paths';
import { formatDateTime } from '../../../lib/format';
import type { EmployeeSummary } from '../../../services/domain.types';

const ROLE_TONE: Record<string, 'brand' | 'info' | 'neutral'> = {
  ADMIN: 'brand',
  FINANCE: 'info',
  DISPATCHER: 'neutral',
};

/** Compact Employee card for narrow screens — opens Employee Detail. */
export function MobileEmployeeCard({ employee }: { employee: EmployeeSummary }) {
  return (
    <Link
      to={paths.management.employeeDetail(employee.id)}
      className="block rounded-card border border-line bg-card p-3 shadow-card hover:border-brand-600"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-ink">
            {employee.firstName} {employee.lastName}
          </p>
          <p className="text-xs text-ink-muted">{employee.employeeNumber}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={ROLE_TONE[employee.role.code] ?? 'neutral'}>
            {employee.role.name}
          </Badge>
          <ActiveBadge isActive={employee.isActive} />
        </div>
      </div>
      <dl className="mt-3 space-y-1 border-t border-line pt-2 text-xs text-ink-muted">
        <div className="flex items-center justify-between gap-2">
          <dt>Email</dt>
          <dd className="truncate">{employee.email}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt>Last login</dt>
          <dd>
            {employee.lastLoginAt
              ? formatDateTime(employee.lastLoginAt)
              : 'Never'}
          </dd>
        </div>
      </dl>
    </Link>
  );
}
