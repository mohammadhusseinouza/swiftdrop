import { configureStore } from '@reduxjs/toolkit';
import { authReducer } from '../features/auth/authSlice';
import { uiReducer } from '../features/ui/uiSlice';
import { ordersUiReducer } from '../features/orders/ordersUiSlice';

/**
 * Phase 10.3 store — client/global state only.
 *
 * Server collections (orders, customers, drivers, wallets, payouts,
 * settlements, dashboard, finance, reports, settings, audit logs) are NOT kept
 * here — RTK Query owns server state starting in Phase 10.4, and its API
 * reducer + middleware are added to this store then.
 *
 * Redux Toolkit's default middleware (serializable + immutable checks, thunk)
 * is kept as-is; all state here is plain and serializable.
 */
export const store = configureStore({
  reducer: {
    auth: authReducer,
    ui: uiReducer,
    ordersUi: ordersUiReducer,
  },
});

export type AppStore = typeof store;
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
