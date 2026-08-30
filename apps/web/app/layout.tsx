import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Salarivo — Tu historia salarial privada',
  description: 'Organizá y revisá tu historia laboral y salarial.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
