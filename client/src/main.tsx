import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { setupListeners } from '@reduxjs/toolkit/query';
import './index.css';
import { store } from './app/store';
import App from './App.tsx';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root not found in index.html');
}

// Enables RTK Query's standard refetchOnFocus / refetchOnReconnect behavior
// (opt-in per endpoint/hook). No custom event listeners, no polling.
setupListeners(store.dispatch);

createRoot(rootElement).render(
  <StrictMode>
    <Provider store={store}>
      <App />
    </Provider>
  </StrictMode>,
);
