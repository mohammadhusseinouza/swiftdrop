import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import {
  selectAuthStatus,
  selectCurrentUser,
} from '../../features/auth/authSlice';
import type { PortalFamily } from '../../features/auth/portal';
import { decidePortal } from './decisions';

/**
 * Portal-family isolation guard (auth + role). Renders inside
 * AuthBootstrapBoundary, so `status` is resolved.
 *
 *   not authenticated       -> /auth/login  (with `from` = current app path in
 *                              router state; no query string, internal only)
 *   unrecognized role       -> /unauthorized (never guess a portal)
 *   wrong portal family     -> the user's OWN portal home (own-portal policy)
 *   correct portal          -> render
 *
 * Role — not permissions — decides the portal (ADMIN holds `driver.*` /
 * `customer.*` permissions but is a Management user). Backend re-authorizes
 * every request regardless.
 */
export default function RequirePortal({ portal }: { portal: PortalFamily }) {
  const status = useAppSelector(selectAuthStatus);
  const user = useAppSelector(selectCurrentUser);
  const location = useLocation();

  const decision = decidePortal({
    status,
    user,
    portal,
    from: location.pathname + location.search,
  });

  switch (decision.kind) {
    case 'allow':
      return <Outlet />;
    case 'login':
      return (
        <Navigate to="/auth/login" replace state={{ from: decision.from }} />
      );
    case 'unauthorized':
      return <Navigate to="/unauthorized" replace />;
    default:
      return <Navigate to={decision.to} replace />;
  }
}
