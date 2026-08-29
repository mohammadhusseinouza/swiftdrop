/**
 * Drop `undefined` / `null` / `''` entries so fetchBaseQuery's `params` never
 * emits `?field=undefined`. Booleans become the string `"true"`/`"false"`
 * (the backend's safe boolean-query convention — never `z.coerce.boolean`).
 */
export function cleanParams(
  input: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = typeof value === 'boolean' ? String(value) : value;
  }
  return out;
}
