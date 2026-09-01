'use client';

import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { useEffect, useRef, useState } from 'react';
import { parseNormalizedRegion, rotateNormalizedRegion, safeCanvasScale } from './document-evidence';
import styles from './document-viewer.module.css';

export type EvidenceField = {
  fieldPath: string;
  id: string | null;
  label: string;
  pageNumber: number | null;
  sourceRegion: unknown;
};

type SignedSource = { expiresAt?: string; url: string };

export function DocumentViewer({
  evidence,
  originalAvailable,
  originalViewable,
  page,
  selectedEvidenceId,
  source,
  sourceBusy,
  sourceError,
  onAuthorize,
  onDownload,
  onEvidenceSelect,
  onPageChange,
}: {
  evidence: EvidenceField[];
  originalAvailable: boolean;
  originalViewable: boolean;
  page: number;
  selectedEvidenceId?: string;
  source: SignedSource | null;
  sourceBusy: boolean;
  sourceError?: string;
  onAuthorize: () => void;
  onDownload: () => void;
  onEvidenceSelect: (id: string) => void;
  onPageChange: (page: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const evidenceRefs = useRef(new Map<string, HTMLButtonElement>());
  const viewerRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTask | undefined>(undefined);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);
  const [fit, setFit] = useState<'page' | 'width'>('width');
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [viewportSize, setViewportSize] = useState({ height: 0, width: 0 });
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState('');
  const [controlError, setControlError] = useState('');

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const update = () => setViewportSize({ height: node.clientHeight, width: node.clientWidth });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === viewerRef.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  useEffect(() => {
    let stopped = false;
    let task: PDFDocumentLoadingTask | undefined;
    void Promise.resolve().then(async () => {
      if (stopped) return;
      setError('');
      setPdf(null);
      setPageCount(0);
      if (!source) { setRendering(false); return; }
      setRendering(true);
      const [pdfjs, worker] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);
      if (stopped) return;
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      task = pdfjs.getDocument({
        url: source.url,
        withCredentials: false,
        cMapUrl: '/pdfjs/cmaps/',
        cMapPacked: true,
        iccUrl: '/pdfjs/iccs/',
        standardFontDataUrl: '/pdfjs/standard_fonts/',
        wasmUrl: '/pdfjs/wasm/',
      });
      const document = await task.promise;
      if (stopped) return;
      setPdf(document);
      setPageCount(document.numPages);
    }).catch(() => {
      if (!stopped) setError('No pudimos mostrar este PDF. Podés reintentar o descargar el original.');
    }).finally(() => { if (!stopped) setRendering(false); });
    return () => {
      stopped = true;
      if (task) void task.destroy();
    };
  }, [source]);

  useEffect(() => {
    if (pageCount && page > pageCount) onPageChange(pageCount);
  }, [onPageChange, page, pageCount]);

  useEffect(() => {
    if (!pdf || !canvasRef.current || !viewportSize.width || !viewportSize.height) return;
    let stopped = false;
    setRendering(true);
    setError('');
    void (async () => {
      const previous = renderTaskRef.current;
      if (previous) {
        previous.cancel();
        try { await previous.promise; }
        catch (caught) { if (!(caught instanceof Error && caught.name === 'RenderingCancelledException')) throw caught; }
      }
      const pdfPage = await pdf.getPage(page);
      if (stopped || !canvasRef.current) return;
      const pageRotation = (pdfPage.rotate + rotation) % 360;
      const base = pdfPage.getViewport({ scale: 1, rotation: pageRotation });
      const availableWidth = Math.max(200, viewportSize.width - 32);
      const availableHeight = Math.max(240, viewportSize.height - 32);
      const desiredScale = (fit === 'width'
        ? availableWidth / base.width
        : Math.min(availableWidth / base.width, availableHeight / base.height)) * zoom;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const scale = safeCanvasScale(base.width, base.height, desiredScale, ratio);
      if (!scale) throw new Error('UNSAFE_CANVAS_DIMENSIONS');
      const viewport = pdfPage.getViewport({ scale, rotation: pageRotation });
      const canvas = canvasRef.current;
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const renderTask = pdfPage.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      renderTaskRef.current = renderTask;
      try { await renderTask.promise; }
      finally {
        if (renderTaskRef.current === renderTask) renderTaskRef.current = undefined;
        pdfPage.cleanup();
      }
      if (page > 1) void pdf.getPage(page - 1).catch(() => undefined);
      if (page < pdf.numPages) void pdf.getPage(page + 1).catch(() => undefined);
    })().catch((caught: unknown) => {
      if (!stopped && !(caught instanceof Error && caught.name === 'RenderingCancelledException')) {
        setError('No pudimos renderizar esta página. La revisión de datos sigue disponible.');
      }
    }).finally(() => { if (!stopped) setRendering(false); });
    return () => { stopped = true; renderTaskRef.current?.cancel(); };
  }, [fit, page, pdf, rotation, viewportSize, zoom]);

  const pageEvidence = evidence.flatMap((field) => {
    if (field.pageNumber !== page || !field.id) return [];
    const region = parseNormalizedRegion(field.sourceRegion);
    return region ? [{ ...field, id: field.id, region: rotateNormalizedRegion(region, rotation) }] : [];
  });
  const visibleError = originalViewable ? error || sourceError : '';

  useEffect(() => {
    if (rendering || !selectedEvidenceId) return;
    evidenceRefs.current.get(selectedEvidenceId)?.scrollIntoView({ block: 'center', inline: 'center' });
  }, [rendering, selectedEvidenceId]);

  function setPage(next: number) {
    if (pageCount) onPageChange(Math.min(pageCount, Math.max(1, next)));
  }

  async function toggleFullscreen() {
    setControlError('');
    try {
      if (fullscreen) await document.exitFullscreen();
      else await viewerRef.current?.requestFullscreen();
    } catch {
      setControlError('No pudimos cambiar el modo de pantalla completa.');
    }
  }

  return (
    <section className={styles.viewer} aria-label="Documento original" ref={viewerRef}>
      <div className={styles.toolbar}>
        <div className={styles.controlGroup}>
          <button type="button" onClick={() => setPage(page - 1)} disabled={page <= 1} aria-label="Página anterior">‹</button>
          <label>Página <input aria-label="Número de página" type="number" min={1} max={pageCount || 1} value={page} onChange={(event) => setPage(Number(event.target.value))} /> <span>de {pageCount || '—'}</span></label>
          <button type="button" onClick={() => setPage(page + 1)} disabled={!pageCount || page >= pageCount} aria-label="Página siguiente">›</button>
        </div>
        <div className={styles.controlGroup}>
          <button type="button" onClick={() => setZoom((value) => Math.max(.5, value - .1))} aria-label="Alejar">−</button>
          <button type="button" onClick={() => setZoom(1)} aria-label="Restablecer zoom" aria-live="polite">{Math.round(zoom * 100)}%</button>
          <button type="button" onClick={() => setZoom((value) => Math.min(3, value + .1))} aria-label="Acercar">+</button>
          <button type="button" className={fit === 'width' ? styles.active : ''} onClick={() => { setFit('width'); setZoom(1); }}>Ancho</button>
          <button type="button" className={fit === 'page' ? styles.active : ''} onClick={() => { setFit('page'); setZoom(1); }}>Página</button>
          <button type="button" onClick={() => setRotation((value) => ((value + 90) % 360) as 0 | 90 | 180 | 270)} aria-label="Rotar página">↻</button>
          <button type="button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa'}>⛶</button>
          <button type="button" onClick={onDownload} disabled={!originalViewable}>Descargar</button>
        </div>
      </div>
      {controlError && <p className={styles.controlError} role="alert">{controlError}</p>}
      <div className={styles.viewport} ref={viewportRef}>
        {!source && !visibleError && <div className={styles.empty}>{originalViewable ? <><p>{sourceBusy ? 'Autorizando vista privada…' : 'La vista privada necesita autorización reciente.'}</p><button type="button" onClick={onAuthorize} disabled={sourceBusy}>{sourceBusy ? 'Autorizando…' : 'Mostrar PDF'}</button></> : <p>{originalAvailable ? 'El original no está habilitado para vista previa.' : 'El archivo original fue eliminado según la política de retención.'} Los datos extraídos siguen disponibles.</p>}</div>}
        {visibleError && <div className={styles.empty} role="alert"><p>{visibleError}</p><div><button type="button" onClick={onAuthorize} disabled={sourceBusy || !originalViewable}>Mostrar PDF</button> <button type="button" onClick={onDownload} disabled={!originalViewable}>Descargar</button></div></div>}
        {source && originalViewable && !visibleError && <div className={styles.page} aria-busy={rendering}>
          <canvas ref={canvasRef} role="img" aria-label={`Página ${page} de ${pageCount || '—'}`} />
          {pageEvidence.map(({ id, label, region }) => <button
            key={id}
            ref={(node) => { if (node) evidenceRefs.current.set(id, node); else evidenceRefs.current.delete(id); }}
            type="button"
            className={`${styles.evidence}${selectedEvidenceId === id ? ` ${styles.selected}` : ''}`}
            style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}
            title={label}
            aria-label={`Evidencia de ${label}`}
            onClick={() => onEvidenceSelect(id)}
          />)}
          {rendering && <span className={styles.loading}>Cargando página…</span>}
        </div>}
      </div>
    </section>
  );
}
