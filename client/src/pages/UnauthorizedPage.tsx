import { Link } from 'react-router-dom';
import { useCurrentUser } from '../features/auth/usePermissions';
import { getDefaultAuthenticatedPath } from '../features/auth/portal';

/**
 * Phase 10.5 temporary "known but forbidden" view — shown when an authenticated
 * user reaches a page their role lacks the permission for (NOT a 404, NOT a
 * redirect to login). Minimal styling; the polished shared component is
 * Phase 10.6.
 *
 * Frontend guards are UX only — the backend independently denies the API calls
 * this page would have made.
 */
export default function UnauthorizedPage() {
  const user = useCurrentUser();
  const home = user ? getDefaultAuthenticatedPath(user) : null;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-100 p-6 text-center dark:bg-slate-950">
      <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        You don&apos;t have permission to access this page.
      </h1>
      {home ? (
        <Link to={home} className="text-sm font-medium text-brand-600 underline">
          Go to your home page
        </Link>
      ) : (
        <Link
          to="/auth/login"
          className="text-sm font-medium text-brand-600 underline"
        >
          Back to sign in
        </Link>
      )}
    </main>
  );
}
