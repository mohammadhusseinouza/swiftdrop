import { Navigate, Outlet } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import {
  selectAuthStatus,
  selectCurrentUser,
} from '../../features/auth/authSlice';
import { decideGuestOnly } from './decisions';

/**
 * Wraps `/auth/*`. Renders inside AuthBootstrapBoundary, so `status` is
 * resolved. An already-authenticated user is sent to their portal home
 * instead of ever seeing the login placeholder.
 */
export default function GuestOnly() {
  const status = useAppSelector(selectAuthStatus);
  const user = useAppSelector(selectCurrentUser);
  const decision = decideGuestOnly(status, user);

  return decision.kind === 'redirect' ? (
    <Navigate to={decision.to} replace />
  ) : (
    <Outlet />
  );
}
