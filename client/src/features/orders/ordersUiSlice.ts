import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../../app/store';

/**
 * CLIENT-ONLY Orders UI state. The slice is named `ordersUi`, not `orders`, on
 * purpose: server Order entities, lists, pagination, loading and error state all
 * belong to RTK Query (Phase 10.4) — never here.
 *
 * Scope for Phase 10.3: bulk-selection ids for the future Orders List
 * (Phase 11.3). List filters are intentionally deferred — most will live in the
 * URL search params, and the Orders API filter contract is a Phase 11.3 concern.
 */
export interface OrdersUiState {
  selectedOrderIds: string[];
}

const initialState: OrdersUiState = {
  selectedOrderIds: [],
};

const ordersUiSlice = createSlice({
  name: 'ordersUi',
  initialState,
  reducers: {
    selectOrder(state, action: PayloadAction<string>) {
      if (!state.selectedOrderIds.includes(action.payload)) {
        state.selectedOrderIds.push(action.payload);
      }
    },
    deselectOrder(state, action: PayloadAction<string>) {
      state.selectedOrderIds = state.selectedOrderIds.filter(
        (id) => id !== action.payload,
      );
    },
    toggleOrderSelection(state, action: PayloadAction<string>) {
      if (state.selectedOrderIds.includes(action.payload)) {
        state.selectedOrderIds = state.selectedOrderIds.filter(
          (id) => id !== action.payload,
        );
      } else {
        state.selectedOrderIds.push(action.payload);
      }
    },
    setSelectedOrderIds(state, action: PayloadAction<string[]>) {
      // Normalise to unique ids so duplicates can never accumulate.
      state.selectedOrderIds = [...new Set(action.payload)];
    },
    clearOrderSelection(state) {
      state.selectedOrderIds = [];
    },
  },
});

export const {
  selectOrder,
  deselectOrder,
  toggleOrderSelection,
  setSelectedOrderIds,
  clearOrderSelection,
} = ordersUiSlice.actions;
export const ordersUiReducer = ordersUiSlice.reducer;

export const selectSelectedOrderIds = (state: RootState): string[] =>
  state.ordersUi.selectedOrderIds;
export const selectSelectedOrderCount = (state: RootState): number =>
  state.ordersUi.selectedOrderIds.length;
export const selectIsOrderSelected =
  (orderId: string) =>
  (state: RootState): boolean =>
    state.ordersUi.selectedOrderIds.includes(orderId);
