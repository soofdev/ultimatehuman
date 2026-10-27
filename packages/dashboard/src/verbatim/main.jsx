// Entry of the vendored pages (app/, copied verbatim from the reference app).
// It plays the part of the Next.js server: run the layout and page server
// components once, then mount what they return. Only /administration/claims
// exists here; the reference sidebar's other links open an empty layout.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app/globals.css';
import { init } from './data-provider';
import AdminLayout from '@/app/(app)/administration/layout';
import ClaimsPage from '@/app/(app)/administration/claims/page';

export async function mount(root) {
  await init();
  const path = window.location.pathname.replace(/\/+$/, '');
  const page = path === '/administration/claims' ? await ClaimsPage() : null;
  const tree = await AdminLayout({ children: page });
  createRoot(root).render(<StrictMode>{tree}</StrictMode>);
}
