import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../../app/store';

/**
 * Global UI state genuinely shared across pages/layouts. Kept minimal — the real
 * Management shell (and any sidebar/nav components) is Phase 11.2. No modal
 * registry here (Phase 10.6 owns modal components); never store React elements.
 */
export interface UiState {
  sidebarCollapsed: boolean;
  mobileNavigationOpen: boolean;
}

const initialState: UiState = {
  sidebarCollapsed: false,
  mobileNavigationOpen: false,
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    setSidebarCollapsed(state, action: PayloadAction<boolean>) {
      state.sidebarCollapsed = action.payload;
    },
    toggleSidebarCollapsed(state) {
      state.sidebarCollapsed = !state.sidebarCollapsed;
    },
    setMobileNavigationOpen(state, action: PayloadAction<boolean>) {
      state.mobileNavigationOpen = action.payload;
    },
    openMobileNavigation(state) {
      state.mobileNavigationOpen = true;
    },
    closeMobileNavigation(state) {
      state.mobileNavigationOpen = false;
    },
  },
});

export const {
  setSidebarCollapsed,
  toggleSidebarCollapsed,
  setMobileNavigationOpen,
  openMobileNavigation,
  closeMobileNavigation,
} = uiSlice.actions;
export const uiReducer = uiSlice.reducer;

export const selectSidebarCollapsed = (state: RootState): boolean =>
  state.ui.sidebarCollapsed;
export const selectMobileNavigationOpen = (state: RootState): boolean =>
  state.ui.mobileNavigationOpen;
