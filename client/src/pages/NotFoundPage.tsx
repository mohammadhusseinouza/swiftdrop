import { Link } from 'react-router-dom';
import { paths } from '../routes/paths';

/**
 * Phase 10.2 application-level 404. Infrastructure only — the polished
 * ErrorState / empty-state design system is Phase 10.6.
 */
export default function NotFoundPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
        Page not found
      </h1>
      <Link to={paths.root} className="text-sm font-medium text-brand-600 underline">
        Back to start
      </Link>
    </main>
  );
}
