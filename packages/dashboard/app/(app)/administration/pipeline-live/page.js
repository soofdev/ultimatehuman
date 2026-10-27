import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import connectDB from '@/lib/db/db';
import PipelineTicket from '@/app/models/pipeline-ticket';
import PipelineSyncStatus from '@/app/models/pipeline-sync-status';
import { liveSnapshot } from '@/app/lib/pipeline-live-data';
import LiveClient from './LiveClient';

export const dynamic = 'force-dynamic';

/**
 * The bug pipeline as one live picture: every ticket on its stage, what waits
 * on Vincent, what is building and what shipped. Read-only; each ticket opens
 * its card on the cockpit (/administration/claims). Super-admin only, like the
 * cockpit (the admin layout only checks `isAdmin`).
 */
export default async function PipelineLivePage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isSuperAdmin) {
    redirect('/administration');
  }
  await connectDB();
  return <LiveClient initial={await liveSnapshot(PipelineTicket, PipelineSyncStatus)} />;
}
