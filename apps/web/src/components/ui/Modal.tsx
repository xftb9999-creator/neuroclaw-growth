import { useEffect, useRef, type ReactNode } from "react";

import { useI18n } from "../../lib/i18n.js";
import { Button } from "./Button.js";

/** 轻量可访问对话框(audit P1-4:审批二次确认载体)。 */
export function Modal(props: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  confirmTestId?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!props.open) return;
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  if (!props.open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/35 px-4"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        className="w-full max-w-md rounded-card bg-white border hairline shadow-lg p-5 grid gap-3 fade-up"
      >
        <h2 className="text-[16.5px] font-bold m-0">{props.title}</h2>
        <div className="text-[14px] text-muted grid gap-2">{props.children}</div>
        <div className="flex flex-wrap justify-end gap-2 mt-1">
          <Button variant="ghost" onClick={props.onClose}>
            {props.cancelLabel ?? t("common.cancel")}
          </Button>
          <Button
            ref={confirmRef}
            variant={props.danger ? "danger" : undefined}
            data-testid={props.confirmTestId}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
