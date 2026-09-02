'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type PublishedLegalDocument = {
  documentType: 'TERMS' | 'PRIVACY_NOTICE';
  version: string;
  locale: 'es-AR';
  title: string;
  content: string;
  effectiveAt: string;
  requiresAcceptance: boolean;
};

const API_ROOT = process.env.NEXT_PUBLIC_API_BASE_URL
  ?? (process.env.NODE_ENV === 'production' ? '/api/v1' : 'http://localhost:3001/api/v1');

export function LegalPage({ type }: { type: 'terms' | 'privacy' }) {
  const [document, setDocument] = useState<PublishedLegalDocument | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const version = new URLSearchParams(window.location.search).get('version');
    const query = version ? `?version=${encodeURIComponent(version)}` : '';
    fetch(`${API_ROOT}/legal/${type}${query}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { data?: PublishedLegalDocument; error?: { message?: string } };
        if (!response.ok) throw new Error(body?.error?.message ?? 'No pudimos cargar el documento.');
        if (!body.data) throw new Error('El documento legal no está disponible.');
        return body.data;
      })
      .then(setDocument)
      .catch((caught) => {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setError(caught instanceof Error ? caught.message : 'No pudimos cargar el documento.');
      });
    return () => controller.abort();
  }, [type]);

  return (
    <main className="legal-layout">
      <header className="legal-header"><Link className="brand" href="/"><span className="brand-mark" aria-hidden="true">S</span><span>Salarivo</span></Link><Link className="button secondary" href="/">Volver</Link></header>
      {error && <p className="message error" role="alert">{error}</p>}
      {!document && !error && <div className="loader" role="status" aria-label="Cargando documento" />}
      {document && <article className="legal-document">
        <p className="eyebrow">Documento legal · versión {document.version}</p>
        <h1>{document.title}</h1>
        <p className="legal-effective">Fecha de vigencia: {new Intl.DateTimeFormat('es-AR', { dateStyle: 'long', timeZone: 'America/Argentina/Buenos_Aires' }).format(new Date(document.effectiveAt))}</p>
        <div className="legal-content">{document.content}</div>
      </article>}
    </main>
  );
}
