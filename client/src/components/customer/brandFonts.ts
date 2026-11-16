/**
 * Brand theme fonts (docs/brand-theme/brand-theme-handoff.md §1.3, decision B-D3 A).
 *
 * Self-hosted through @fontsource (pinned) — no third-party font request.
 * These files only DECLARE the `Saira` and `Inter Variable` font faces; a face
 * is downloaded only where it is used, i.e. under `font-sd-display` /
 * `font-sd-body` on the Customer shell root (and the AuthLayout root in B4).
 * `Inter Variable` is a different family name from the global `Inter`
 * fallback stack, so Management and Driver typography is unaffected.
 *
 * Import this module from a brand-themed shell, never globally.
 */
import '@fontsource/saira/500.css';
import '@fontsource/saira/600.css';
import '@fontsource/saira/700.css';
import '@fontsource/saira/700-italic.css';
import '@fontsource/saira/800.css';
import '@fontsource-variable/inter/wght.css';
