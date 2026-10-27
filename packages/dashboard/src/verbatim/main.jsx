// Entry of the vendored pages (app/, copied verbatim from the reference app).
// It plays the part of the Next.js server: run the layout and page server
// components once, then mount what they return. Two pages exist here, the
// two the sidebar lists; any other /administration path opens an empty layout.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app/globals.css';
import { init } from './data-provider';
import AdminLayout from '@/app/(app)/administration/layout';
import ClaimsPage from '@/app/(app)/administration/claims/page';
import PipelineLivePage from '@/app/(app)/administration/pipeline-live/page';

const PAGES = { '/administration/claims': ClaimsPage, '/administration/pipeline-live': PipelineLivePage };

export async function mount(root) {
  await init();
  const path = window.location.pathname.replace(/\/+$/, '');
  const page = PAGES[path] ? await PAGES[path]() : null;
  const tree = await AdminLayout({ children: page });
  createRoot(root).render(<StrictMode>{tree}</StrictMode>);
}
