import { configureStore } from '@reduxjs/toolkit';
import { authReducer } from '../features/auth/authSlice';
import { uiReducer } from '../features/ui/uiSlice';
import { ordersUiReducer } from '../features/orders/ordersUiSlice';
import { api } from '../services/api';

/**
 * Root store.
 *
 * Client/global state lives in ordinary slices (`auth`, `ui`, `ordersUi`).
 * ALL server state lives in the single RTK Query cache reducer (`api`) — there
 * is one `createApi` instance, so exactly one API reducer and one API
 * middleware, no matter how many domain modules inject endpoints into it.
 *
 * Redux Toolkit's default middleware (thunk + serializable + immutable checks)
 * is kept as-is and the RTK Query middleware is appended.
 */
export const store = configureStore({
  reducer: {
    auth: authReducer,
    ui: uiReducer,
    ordersUi: ordersUiReducer,
    [api.reducerPath]: api.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(api.middleware),
});

export type AppStore = typeof store;
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
