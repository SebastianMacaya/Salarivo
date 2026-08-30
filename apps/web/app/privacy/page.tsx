import type { Metadata } from 'next';
import { LegalPage } from '../legal-page';

export const metadata: Metadata = { title: 'Aviso de privacidad — Salarivo' };

export default function PrivacyPage() {
  return <LegalPage type="privacy" />;
}
