import { useEffect, useState } from 'react';

/**
 * Returns `value` delayed by `delayMs`. Used to keep a fast-updating text input
 * responsive while only committing to URL / firing a server query after the
 * user pauses. No dependency — a plain timeout.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
