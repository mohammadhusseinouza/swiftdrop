import type { HTMLAttributes } from 'react';
import { cn } from './cn';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Remove default inner padding (e.g. when the card wraps a table). */
  flush?: boolean;
}

/** White surface with the standard SwiftDrop border + radius + shadow. */
export function Card({ flush = false, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-card border border-line bg-card shadow-card',
        !flush && 'p-4 sm:p-5',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
