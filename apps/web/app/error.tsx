'use client';

import Link from 'next/link';

export default function ErrorPage({ reset }: { reset: () => void }) {
  return <main className="center-screen" role="alert">
    <p className="eyebrow">Salarivo</p>
    <h1>No pudimos mostrar esta pantalla</h1>
    <p>Reintentá para volver a cargar la información.</p>
    <button type="button" className="button primary" onClick={reset}>Reintentar</button>
    <Link className="button secondary" href="/">Volver al inicio</Link>
  </main>;
}
