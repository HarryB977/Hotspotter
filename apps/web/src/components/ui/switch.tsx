import * as React from 'react';
import { cn } from '../../lib/utils';

export interface SwitchProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  checked: boolean;
  onCheckedChange(checked: boolean): void;
}

/** On/off toggle with the shadcn Switch API (role="switch"), without the Radix dependency. */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onCheckedChange, className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? 'checked' : 'unchecked'}
      className={cn(
        'inline-flex h-3.5 w-6 shrink-0 cursor-pointer items-center rounded-full border border-zinc-700 transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-zinc-800',
        className,
      )}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    >
      <span
        className={cn(
          'pointer-events-none block h-2.5 w-2.5 rounded-full bg-zinc-100 shadow transition-transform',
          checked ? 'translate-x-[11px]' : 'translate-x-[1px]',
        )}
      />
    </button>
  ),
);
Switch.displayName = 'Switch';
