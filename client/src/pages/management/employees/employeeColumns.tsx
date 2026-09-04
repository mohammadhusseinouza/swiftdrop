import { Link } from 'react-router-dom';

import type { DataTableColumn } from '../../../components/data-display/DataTable';
import { Badge } from '../../../components/ui/Badge';
import { ActiveBadge } from '../../../components/ui/ActiveBadge';
import { paths } from '../../../routes/paths';
import { formatDate, formatDateTime } from '../../../lib/format';
import type { EmployeeSummary } from '../../../services/domain.types';

const DASH = '—';

const ROLE_TONE: Record<string, 'brand' | 'info' | 'neutral'> = {
  ADMIN: 'brand',
  FINANCE: 'info',
  DISPATCHER: 'neutral',
};

export const employeeColumns: DataTableColumn<EmployeeSummary>[] = [
  {
    id: 'employee',
    header: 'Employee',
    cell: (e) => (
      <Link
        to={paths.management.employeeDetail(e.id)}
        className="font-medium text-brand-600 hover:underline"
      >
        <span className="block">
          {e.firstName} {e.lastName}
        </span>
        <span className="block text-xs font-normal text-ink-muted">
          {e.employeeNumber}
        </span>
      </Link>
    ),
  },
  {
    id: 'role',
    header: 'Role',
    cell: (e) => (
      <Badge tone={ROLE_TONE[e.role.code] ?? 'neutral'}>{e.role.name}</Badge>
    ),
  },
  {
    id: 'email',
    header: 'Email',
    hideBelow: 'lg',
    cell: (e) => (
      <a
        href={`mailto:${e.email}`}
        className="break-all text-brand-600 hover:underline"
      >
        {e.email}
      </a>
    ),
  },
  {
    id: 'phone',
    header: 'Phone',
    hideBelow: 'xl',
    cell: (e) => e.phone ?? DASH,
  },
  {
    id: 'status',
    header: 'Status',
    cell: (e) => <ActiveBadge isActive={e.isActive} />,
  },
  {
    id: 'lastLogin',
    header: 'Last login',
    hideBelow: 'md',
    cell: (e) =>
      e.lastLoginAt ? (
        formatDateTime(e.lastLoginAt)
      ) : (
        <span className="text-ink-subtle">Never</span>
      ),
  },
  {
    id: 'created',
    header: 'Created',
    hideBelow: 'xl',
    cell: (e) => formatDate(e.createdAt),
  },
];
