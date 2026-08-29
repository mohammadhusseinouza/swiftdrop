import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query. Used by the Management shell to route the
 * single navbar toggle to the right action (desktop collapse vs mobile drawer)
 * and to close the mobile drawer when the viewport grows to desktop.
 *
 * SSR-safe: returns `false` until mounted.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Tailwind `md` breakpoint (min-width: 48rem). */
export const MD_QUERY = '(min-width: 48rem)';
