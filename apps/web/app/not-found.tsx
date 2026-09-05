import Link from 'next/link';

export default function NotFound() {
  return <main className="center-screen">
    <p className="eyebrow">Salarivo · 404</p>
    <h1>No encontramos esta página</h1>
    <p>El enlace puede haber cambiado. Volvé a tu espacio para continuar.</p>
    <Link className="button primary" href="/">Volver a Salarivo</Link>
  </main>;
}
