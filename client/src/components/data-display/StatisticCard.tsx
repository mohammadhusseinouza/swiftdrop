import type { ComponentType, ReactNode } from 'react';
import type { LucideProps } from 'lucide-react';
import { cn } from '../ui/cn';
import { Card } from '../ui/Card';

export interface StatisticCardProps {
  label: string;
  /**
   * Already display-safe value (e.g. a formatted money string). This component
   * does NOT parse or calculate anything.
   */
  value: ReactNode;
  supportingText?: ReactNode;
  icon?: ComponentType<LucideProps>;
  /** Optional secondary slot (trend chip, comparison, etc.). */
  aside?: ReactNode;
  className?: string;
}

export function StatisticCard({
  label,
  value,
  supportingText,
  icon: Icon,
  aside,
  className,
}: StatisticCardProps) {
  return (
    <Card className={cn('flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
          {label}
        </p>
        <p className="mt-1.5 text-2xl font-semibold tracking-tight text-ink">
          {value}
        </p>
        {supportingText && (
          <p className="mt-1 text-xs text-ink-muted">{supportingText}</p>
        )}
        {aside && <div className="mt-2">{aside}</div>}
      </div>
      {Icon && (
        <span className="rounded-control bg-brand-50 p-2 text-brand-600">
          <Icon className="size-5" aria-hidden="true" />
        </span>
      )}
    </Card>
  );
}
