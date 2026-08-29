import { createBrowserRouter } from 'react-router-dom';
import { routeTree } from './routeTree';

/**
 * Phase 10.2 router entry. The route tree and all phase-ownership notes live in
 * ./routeTree.tsx (kept as a plain array so it can be verified with matchRoutes
 * without a DOM).
 */
export const router = createBrowserRouter(routeTree);
