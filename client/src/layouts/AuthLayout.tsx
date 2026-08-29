import { Outlet } from 'react-router-dom';

/**
 * Phase 10.2 routing boundary for unauthenticated / auth pages.
 * The real Login Page is Phase 11.1. No auth logic here.
 */
export default function AuthLayout() {
  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-950">
      <main className="flex min-h-screen items-center justify-center p-6">
        <Outlet />
      </main>
    </div>
  );
}
