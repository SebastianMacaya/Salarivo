'use client';

import { type ReactNode, useEffect, useRef } from 'react';

/** Native focus containment and background isolation; layout lives in globals.css. */
export function ResponsiveDialog({ children, labelId, onClose, busy = false }: {
  children: ReactNode;
  labelId: string;
  onClose: () => void;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className="modal-layer" aria-labelledby={labelId} aria-busy={busy}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    onClick={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    {children}
  </dialog>;
}
