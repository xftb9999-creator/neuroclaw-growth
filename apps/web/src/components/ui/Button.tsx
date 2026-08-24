import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/cn.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 font-medium transition-all duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60 disabled:cursor-default cursor-pointer",
  {
    variants: {
      variant: {
        primary:
          "text-white rounded-pill px-5 py-3 bg-gradient-to-br from-brand to-brand-dark shadow-[0_10px_30px_rgba(216,102,63,0.35)] hover:shadow-[0_12px_36px_rgba(216,102,63,0.5)] hover:brightness-110 active:brightness-95",
        secondary:
          "bg-surface-strong text-ink rounded-pill px-5 py-3 border border-line-strong hover:bg-line",
        ghost:
          "bg-transparent text-muted hover:text-ink hover:bg-surface-strong rounded-pill px-4 py-2",
        danger: "bg-danger text-white hover:opacity-90 rounded-pill px-5 py-3",
        outline:
          "border border-line-strong bg-transparent text-ink hover:bg-surface-strong rounded-pill px-5 py-3"
      },
      size: {
        sm: "text-sm px-3 py-1.5",
        md: "text-base px-5 py-2.5",
        lg: "text-lg px-6 py-3"
      }
    },
    defaultVariants: {
      variant: "primary",
      size: "md"
    }
  }
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  "aria-label"?: string;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  }
);

Button.displayName = "Button";
