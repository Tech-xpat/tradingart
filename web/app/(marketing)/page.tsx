import { readFileSync } from 'fs';
import { join } from 'path';
import Script from 'next/script';
import './landing.css';

export const metadata = { title: 'ART · African Robot Trader' };

// The landing markup is static HTML; the hero animation is public/landing.js
const html = readFileSync(join(process.cwd(), 'app/(marketing)/landing.html'), 'utf8');

export default function Landing() {
  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      <Script src="/landing.js?v=1" strategy="afterInteractive" />
    </>
  );
}
