import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import connectDB from '@/lib/db/db';
import PlatformClaim from '@/app/models/platform-claim';
import PipelineTicket from '@/app/models/pipeline-ticket';
import PipelineBundles from '@/app/models/pipeline-bundles';
import CockpitClient from './CockpitClient';
import FocusTicket from './FocusTicket';

export const dynamic = 'force-dynamic';

/**
 * The pipeline cockpit: fixes ready to merge (read here, merged on GitHub),
 * tickets needing a decision, the MAX claims ledger, and what shipped this
 * week. Super-admin only: guarded
 * server-side on `isSuperAdmin` (the admin layout only checks `isAdmin`, so
 * plain admins reaching this URL are bounced back to the admin home). The
 * matching sidebar entry is `superadminOnly`.
 */
export default async function ClaimsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.isSuperAdmin) {
    redirect('/administration');
  }
  await connectDB();
  const [claims, tickets, bundles] = await Promise.all([
    PlatformClaim.find({}, { _id: 0, __v: 0 }).lean(),
    PipelineTicket.find({ queue: { $ne: null } }, { _id: 0, __v: 0, 'decision.raw': 0 }).lean(),
    PipelineBundles.findOne({ name: 'current' }, { _id: 0, __v: 0 }).lean(),
  ]);
  return (
    <Suspense>
      <CockpitClient
        initialClaims={JSON.parse(JSON.stringify(claims))}
        initialTickets={JSON.parse(JSON.stringify(tickets))}
        // suggested bundles (pipeline flag COCKPIT_BUNDLES): no document = no prop, the page unchanged
        {...(bundles ? { initialBundles: JSON.parse(JSON.stringify(bundles)) } : {})}
      />
      {/* ?focus=KEY (from the live pipeline page): scroll to that ticket's card */}
      <FocusTicket />
    </Suspense>
  );
}
