'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './pwa-controls.module.css';

type InstallPrompt = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export function PwaControls({ children }: { children: ReactNode }) {
  const [offline, setOffline] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  const [iosInstall, setIosInstall] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);
  const [message, setMessage] = useState('');
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const updateRequested = useRef(false);
  const offlineDialog = useRef<HTMLDialogElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const connectionChanged = () => setOffline(!navigator.onLine);
    const showInstall = (event: Event) => {
      event.preventDefault();
      if (ios || /Android/.test(navigator.userAgent)) setInstallPrompt(event as InstallPrompt);
    };
    const installed = () => { setInstallPrompt(null); setIosInstall(false); };
    const displayMode = window.matchMedia('(display-mode: standalone)');
    const standalone = displayMode.matches || (navigator as Navigator & { standalone?: boolean }).standalone;
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    queueMicrotask(() => { connectionChanged(); setIosInstall(Boolean(ios && !standalone)); });
    if (!standalone) window.addEventListener('beforeinstallprompt', showInstall);
    window.addEventListener('appinstalled', installed);
    window.addEventListener('online', connectionChanged);
    window.addEventListener('offline', connectionChanged);
    displayMode.addEventListener('change', installed);
    return () => {
      window.removeEventListener('beforeinstallprompt', showInstall);
      window.removeEventListener('appinstalled', installed);
      window.removeEventListener('online', connectionChanged);
      window.removeEventListener('offline', connectionChanged);
      displayMode.removeEventListener('change', installed);
    };
  }, []);

  useEffect(() => {
    if (offline) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // Modal dialogs escape ancestor inert/visibility, including ones opened by pending requests.
      const hiddenDialogs = new Map<HTMLDialogElement, { inert: boolean; visibility: string }>();
      const concealDialogs = () => content.current?.querySelectorAll('dialog').forEach((dialog) => {
        if (!hiddenDialogs.has(dialog)) hiddenDialogs.set(dialog, { inert: dialog.inert, visibility: dialog.style.visibility });
        dialog.inert = true;
        dialog.style.visibility = 'hidden';
      });
      concealDialogs();
      if (!offlineDialog.current?.open) offlineDialog.current?.showModal();
      retryButton.current?.focus();
      const observer = new MutationObserver((changes) => {
        concealDialogs();
        const opened = changes.some((change) => change.type === 'attributes'
          ? change.target instanceof HTMLDialogElement && change.target.open
          : Array.from(change.addedNodes).some((node) => node instanceof Element
            && (node.matches('dialog[open]') || node.querySelector('dialog[open]'))));
        if (opened) {
          offlineDialog.current?.close();
          offlineDialog.current?.showModal();
          retryButton.current?.focus();
        }
      });
      if (content.current) observer.observe(content.current, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
      return () => {
        observer.disconnect();
        for (const [dialog, prior] of hiddenDialogs) {
          dialog.inert = prior.inert;
          dialog.style.visibility = prior.visibility;
        }
      };
    } else {
      offlineDialog.current?.close();
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
      previousFocus.current = null;
    }
  }, [offline]);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator) || !window.isSecureContext) return;
    let disposed = false;
    let installing: ServiceWorker | null = null;
    const checkWaiting = () => {
      if (!disposed) setUpdateReady(Boolean(registration.current?.waiting && navigator.serviceWorker.controller));
    };
    const updateFound = () => {
      installing?.removeEventListener('statechange', checkWaiting);
      installing = registration.current?.installing ?? null;
      installing?.addEventListener('statechange', checkWaiting);
    };
    const checkForUpdate = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void registration.current?.update().catch(() => {});
    };
    const controllerChanged = () => {
      if (updateRequested.current) window.location.reload();
    };
    const workerMessage = (event: MessageEvent) => {
      if (event.data?.type === 'UPDATE_OTHER_WINDOWS') {
        updateRequested.current = false;
        setMessage('Cerrá las otras pestañas o ventanas de Salarivo y volvé a actualizar.');
      }
    };
    navigator.serviceWorker.addEventListener('controllerchange', controllerChanged);
    navigator.serviceWorker.addEventListener('message', workerMessage);
    document.addEventListener('visibilitychange', checkForUpdate);
    window.addEventListener('online', checkForUpdate);
    const interval = window.setInterval(checkForUpdate, 60 * 60 * 1000);
    void navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then((result) => {
      if (disposed) return;
      registration.current = result;
      result.addEventListener('updatefound', updateFound);
      updateFound();
      checkWaiting();
      checkForUpdate();
    }).catch(() => { /* PWA support is optional; normal online flows remain available. */ });
    return () => {
      disposed = true;
      registration.current?.removeEventListener('updatefound', updateFound);
      installing?.removeEventListener('statechange', checkWaiting);
      navigator.serviceWorker.removeEventListener('controllerchange', controllerChanged);
      navigator.serviceWorker.removeEventListener('message', workerMessage);
      document.removeEventListener('visibilitychange', checkForUpdate);
      window.removeEventListener('online', checkForUpdate);
      window.clearInterval(interval);
    };
  }, []);

  async function install() {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
    } catch {
      setMessage('Podés instalar Salarivo desde el menú de tu navegador.');
    } finally {
      setInstallPrompt(null);
    }
  }

  function update() {
    const waiting = registration.current?.waiting;
    if (!waiting || !window.confirm('Guardá los cambios y esperá a que terminen las subidas antes de continuar. ¿Actualizar Salarivo ahora?')) return;
    updateRequested.current = true;
    setMessage('Preparando la actualización…');
    waiting.postMessage({ type: 'ACTIVATE_UPDATE' });
  }

  return <>
    <dialog ref={offlineDialog} className={styles.offline} aria-labelledby="offline-title" onCancel={(event) => event.preventDefault()}>
      <div>
        <span className={styles.brand}>Salarivo</span>
        <h1 id="offline-title">Sin conexión</h1>
        <p>Necesitás conexión a Internet para acceder a esta información.</p>
        <p>Cuando vuelva la conexión, podrás continuar en esta pantalla. Revisá el estado de cualquier subida interrumpida.</p>
        <button ref={retryButton} type="button" onClick={() => {
          if (navigator.onLine) { setOffline(false); setMessage(''); }
          else setMessage('Todavía no hay conexión. Volvé a intentarlo en unos instantes.');
        }}>Reintentar</button>
        {message && <p role="status">{message}</p>}
      </div>
    </dialog>
    <div ref={content} className={styles.content} inert={offline} style={offline ? { visibility: 'hidden' } : undefined}>
      {(installPrompt || iosInstall || updateReady || message) && <aside className={styles.controls} aria-label="Aplicación Salarivo">
        {installPrompt && <button type="button" onClick={() => void install()}>Instalar Salarivo</button>}
        {iosInstall && <details><summary>Instalar en iPhone o iPad</summary><p>Abrí el menú Compartir del navegador y elegí Agregar a pantalla de inicio. Si aparece la opción, activá Abrir como app web.</p></details>}
        {updateReady && <><span>Hay una nueva versión disponible.</span><button type="button" onClick={update}>Actualizar</button></>}
        {message && <p role="status">{message}</p>}
      </aside>}
      {children}
    </div>
  </>;
}
