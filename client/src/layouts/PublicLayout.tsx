import { Outlet } from 'react-router-dom';

/**
 * Phase 10.2 ROUTING BOUNDARY ONLY for public (unauthenticated) pages.
 *
 * The real Public Tracking UI and its safe backend DTO are Phase 14.
 * No authentication logic and no API calls here.
 */
export default function PublicLayout() {
  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-950">
      <main className="flex min-h-screen items-center justify-center p-6">
        <Outlet />
      </main>
    </div>
  );
}
