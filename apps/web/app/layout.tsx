import type { Metadata, Viewport } from 'next';
import { PwaControls } from './pwa-controls';
import './globals.css';

export const metadata: Metadata = {
  title: 'Salarivo — Tu historia salarial privada',
  description: 'Organizá y revisá tu historia laboral y salarial.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Salarivo',
  appleWebApp: { capable: true, title: 'Salarivo', statusBarStyle: 'default' },
  icons: {
    icon: [{ url: '/pwa/logo.svg', type: 'image/svg+xml' }, { url: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png' }],
    apple: [{ url: '/pwa/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#176c4a',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body><PwaControls>{children}</PwaControls></body>
    </html>
  );
}
