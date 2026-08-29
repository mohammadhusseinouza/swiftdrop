import { Outlet } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectPermissions } from '../../features/auth/authSlice';
import { decidePermission } from './decisions';
import UnauthorizedPage from '../../pages/UnauthorizedPage';

/**
 * Page-level permission guard. Assumes the outer RequirePortal already
 * confirmed auth + the correct portal family.
 *
 * A missing permission renders the Unauthorized view IN PLACE (the forbidden
 * URL stays in the address bar) — it does NOT redirect to login and does NOT
 * fall through to a 404. Makes no backend call itself.
 *
 * `permission` is one code or an array (OR semantics).
 */
export default function RequirePermission({
  permission,
}: {
  permission: string | readonly string[];
}) {
  const permissions = useAppSelector(selectPermissions);
  const required = typeof permission === 'string' ? [permission] : permission;
  const decision = decidePermission(permissions, required);

  return decision.kind === 'allow' ? <Outlet /> : <UnauthorizedPage />;
}
