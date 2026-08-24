import { cva, type VariantProps } from "class-variance-authority";
import {
  forwardRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type LabelHTMLAttributes,
  type TextareaHTMLAttributes
} from "react";

import { cn } from "../../lib/cn.js";

const inputBase =
  "w-full border border-line bg-white/[0.04] rounded-input px-4 py-3 text-ink placeholder:text-muted/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand transition-colors hover:border-line-strong";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => {
    return <input ref={ref} className={cn(inputBase, className)} {...props} />;
  }
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(inputBase, "min-h-[140px] resize-vertical", className)}
        {...props}
      />
    );
  }
);
Textarea.displayName = "Textarea";

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => {
    return (
      <label ref={ref} className={cn("grid gap-1.5 text-sm font-medium text-ink", className)} {...props} />
    );
  }
);
Label.displayName = "Label";

const badgeVariants = cva(
  "inline-flex items-center rounded-pill px-3 py-1 text-sm font-medium capitalize border",
  {
    variants: {
      variant: {
        default: "bg-brand-light text-brand border-brand-dark/40",
        completed: "bg-ok-light text-ok border-ok/30",
        waiting: "bg-warn-light text-warn border-warn/30",
        failed: "bg-danger-light text-danger border-danger/30",
        running: "bg-brand-light text-brand border-brand-dark/40",
        info: "bg-surface-strong text-muted border-line-strong"
      }
    },
    defaultVariants: {
      variant: "default"
    }
  }
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => {
    return (
      <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />
    );
  }
);
Badge.displayName = "Badge";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton h-4 w-full", className)} aria-hidden="true" />;
}
