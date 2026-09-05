'use client';

import { type ReactNode, useEffect, useRef } from 'react';

export function AppNavigation({ open, onClose, id, label, className, children }: {
  open: boolean;
  onClose: () => void;
  id: string;
  label: string;
  className: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const desktop = window.matchMedia('(min-width: 1024px)');
    function sync() {
      if (!dialog) return;
      const modal = !desktop.matches && open;
      if (dialog.open && dialog.matches(':modal') !== modal) dialog.close();
      if (desktop.matches && !dialog.open) dialog.show();
      else if (modal && !dialog.open) dialog.showModal();
      else if (!desktop.matches && !open && dialog.open) dialog.close();
    }
    function resize() {
      if (desktop.matches) onClose();
      sync();
    }
    sync();
    desktop.addEventListener('change', resize);
    return () => desktop.removeEventListener('change', resize);
  }, [open, onClose]);

  return <dialog ref={ref} id={id} className={className} aria-label={label}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClose={() => { if (!ref.current?.open) onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget || !event.currentTarget.matches(':modal')) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    {children}
  </dialog>;
}
