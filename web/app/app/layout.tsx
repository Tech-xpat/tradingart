import type { ReactNode } from 'react';
import Providers from '@/components/Providers';
import './app.css';

export const metadata = { title: 'ART · Dashboard' };
export default function AppLayout({ children }: { children: ReactNode }) {
  return <Providers>{children}</Providers>;
}
