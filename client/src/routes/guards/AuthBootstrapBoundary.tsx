import { Outlet } from 'react-router-dom';
import { useAppSelector } from '../../app/hooks';
import { selectAuthStatus } from '../../features/auth/authSlice';
import { useGetMeQuery } from '../../services/authApi';
import {
  BootstrapError,
  BootstrapLoading,
} from '../../pages/auth/BootstrapStatusPages';

/**
 * Pathless boundary that wraps `/`, `/auth/*`, `/management/*`, `/driver/*`,
 * `/customer/*`. `/track` is deliberately OUTSIDE it — public tracking must
 * render without waiting for an auth request.
 *
 * Flow (a browser reload has no in-memory access token):
 *   status 'unknown'  -> fire GET /auth/me (RTK Query dedupes; StrictMode-safe)
 *     -> success             : getMe.onQueryStarted dispatches setAuthenticatedUser -> 'authenticated'
 *     -> 401 (after 1 refresh): baseQueryWithReauth dispatches setUnauthenticated  -> 'unauthenticated'
 *     -> transport / 5xx     : status stays 'unknown' -> show retry view (do NOT log out)
 *
 * No child route renders — and therefore no redirect fires — until bootstrap
 * resolves, which prevents a login-page flash while a valid refresh cookie is
 * being checked.
 */
export default function AuthBootstrapBoundary() {
  const status = useAppSelector(selectAuthStatus);
  const { isError, refetch } = useGetMeQuery(undefined, {
    skip: status !== 'unknown',
  });

  if (status !== 'unknown') {
    return <Outlet />;
  }

  // Still resolving. A 401 would already have moved status to 'unauthenticated'
  // above, so an error here means the server was unreachable / erroring.
  if (isError) {
    return <BootstrapError onRetry={() => void refetch()} />;
  }

  return <BootstrapLoading />;
}
