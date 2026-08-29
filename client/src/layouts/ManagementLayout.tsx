import { Outlet } from 'react-router-dom';

/**
 * Phase 10.2 ROUTING BOUNDARY ONLY.
 *
 * The real Management Shell — Sidebar, Top Navbar, responsive drawer, user menu,
 * notifications, permission-aware navigation — is Phase 11.2. Do not add it here.
 * Auth/permission guards for this group are Phase 10.5.
 */
export default function ManagementLayout() {
  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-950">
      <main className="p-6">
        <Outlet />
      </main>
    </div>
  );
}
