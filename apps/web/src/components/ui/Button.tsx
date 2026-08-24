import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "../../lib/cn.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60 disabled:cursor-default cursor-pointer",
  {
    variants: {
      variant: {
        primary: "bg-brand text-white hover:bg-brand-dark rounded-pill px-5 py-3",
        secondary: "bg-brand-light text-ink hover:bg-line rounded-pill px-5 py-3",
        ghost: "bg-transparent text-ink hover:bg-brand-light rounded-pill px-4 py-2",
        danger: "bg-danger text-white hover:opacity-90 rounded-pill px-5 py-3",
        outline: "border border-line bg-white text-ink hover:bg-brand-light rounded-pill px-5 py-3"
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
