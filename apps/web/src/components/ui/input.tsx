import * as React from 'react';
import { cn } from '../../lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'h-6 w-full min-w-0 rounded border border-zinc-800 bg-zinc-900 px-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:border-accent focus-visible:outline-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
