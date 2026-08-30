import type { Metadata } from 'next';
import { LegalPage } from '../legal-page';

export const metadata: Metadata = { title: 'Términos de uso — Salarivo' };

export default function TermsPage() {
  return <LegalPage type="terms" />;
}
