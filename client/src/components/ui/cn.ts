import { clsx, type ClassValue } from 'clsx';

/** Conditional Tailwind class composition. Thin wrapper over clsx. */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
