import { Outlet } from 'react-router-dom';

/**
 * Routing boundary for unauthenticated / auth pages (Phase 10.2). Kept
 * deliberately minimal — it centres a single auth surface (the Login page,
 * Phase 11.1). No application chrome, no sidebar/navbar.
 */
export default function AuthLayout() {
  return (
    <div className="min-h-screen bg-canvas">
      <main className="flex min-h-screen items-center justify-center p-4 sm:p-6">
        <Outlet />
      </main>
    </div>
  );
}
