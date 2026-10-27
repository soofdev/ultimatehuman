import { CHART_DAYS, LIVE_PROJECTION } from '@/app/lib/pipeline-live';

/**
 * Server read for the live pipeline page (the page's first render and its
 * poll): the tickets on a queue plus the ones merged within the chart's window,
 * and when the pipeline last pushed. Plain JSON.
 */
export async function liveSnapshot(PipelineTicket, PipelineSyncStatus) {
  // one day of slack: the chart's first day starts at the viewer's midnight
  const since = new Date(Date.now() - (CHART_DAYS + 1) * 24 * 3600 * 1000);
  const [tickets, status] = await Promise.all([
    PipelineTicket.find({ $or: [{ queue: { $ne: null } }, { merged_at: { $gte: since } }] }, LIVE_PROJECTION).lean(),
    PipelineSyncStatus.findOne({ name: 'current' }, { _id: 0, last_push_at: 1, received: 1, changed: 1 }).lean(),
  ]);
  return JSON.parse(JSON.stringify({ tickets, sync: status || null, read_at: new Date() }));
}
