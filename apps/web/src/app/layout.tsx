import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'KitchOS', template: '%s · KitchOS' },
  description: 'KitchOS — The Intelligent Restaurant Operating System. Order. Operate. Optimise.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#c2410c' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-AU">
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
