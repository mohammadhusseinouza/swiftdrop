import { Outlet } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectCurrentUser } from '../../features/auth/authSlice';
import { decideRole } from './decisions';
import UnauthorizedPage from '../../pages/UnauthorizedPage';

/**
 * Page-level ROLE guard — sibling of RequirePermission for role-scoped
 * modules. Assumes RequirePortal already confirmed auth + portal family.
 * Renders the Unauthorized view in place (URL kept). UX only: the backend
 * independently enforces the same role on every endpoint.
 */
export default function RequireRole({ roles }: { roles: readonly string[] }) {
  const user = useAppSelector(selectCurrentUser);
  return decideRole(user?.role.code, roles).kind === 'allow' ? <Outlet /> : <UnauthorizedPage />;
}
