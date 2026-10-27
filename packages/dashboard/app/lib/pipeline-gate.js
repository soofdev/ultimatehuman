/**
 * The validation gate and ticket merge of the pipeline cockpit
 * (/administration/claims, "To validate" tab). Pure helpers, shared by the
 * routes and the page.
 *
 * A backlog fix ticket is MAX-related when fixing and checking it drives MAX
 * conversations (what costs money): it carries `max-auto` (the radar's MAX
 * scope, also every ticket filed from a claims ruling or build request) or
 * `claims-ruling`, or a claim ruled wrong links to it. Those wait for
 * Vincent's validation (`gate: 'pending'`); Validate adds the Jira label
 * `max-go`, the only promotion the conductor queues. A non-MAX ticket is
 * `auto` and flows on its own.
 */

export const GO_LABEL = 'max-go';
export const DECLINED_LABELS = ['max-declined', 'max-cancelled'];
export const SUPERSEDED_LABEL = 'superseded';
export const MERGED_LABEL = 'cockpit-merged';
const MAX_LABELS = ['max-auto', 'claims-ruling'];
// Labels a survivor takes over from the tickets it absorbs: automation scope,
// the claims a ruling propagation looks for, area, severity.
const CARRIED_LABEL = /^(max-auto|radar-auto|claims-ruling|claims-feature|claim-[A-Za-z0-9-]+|area-[a-z0-9-]+|decision-qa-test)$/;
const SEVERITIES = ['sev-blocker', 'sev-major', 'sev-minor'];

export const GATES = ['pending', 'later', 'validated', 'dismissed', 'auto'];
// Waiting on Vincent: shown with Validate / Later / Dismiss.
export const GATE_OPEN = ['pending', 'later'];
export const MERGE_MIN = 2;
export const MERGE_MAX = 10;
export const DISMISS_NOTE_MAX = 300;
// Jira refuses a description over 32767 characters.
const DESCRIPTION_BUDGET = 30000;

export const claimIdsOfLabels = (labels) => (labels || [])
  .map((l) => /^claim-(C-[A-Za-z0-9-]+)$/.exec(l)?.[1]).filter(Boolean);

/**
 * True when fixing the ticket drives MAX. `wrongClaims` = the claims ruled
 * wrong, as [{ claim_id, tickets: [{ key }] }].
 */
export function isMaxRelated({ key, labels, claim_ids: claimIds }, wrongClaims = []) {
  if ((labels || []).some((l) => MAX_LABELS.includes(l))) return true;
  const ids = new Set([...(claimIds || []), ...claimIdsOfLabels(labels)]);
  return wrongClaims.some((c) => ids.has(c.claim_id) || (c.tickets || []).some((t) => t.key === key));
}

/**
 * The gate a synced backlog ticket gets. Vincent's own choices (later,
 * validated, dismissed) are never overwritten; a ticket he labelled max-go on
 * Jira himself counts as validated.
 */
export function seedGate(current, { labels, max_related: maxRelated }) {
  if (['later', 'validated', 'dismissed'].includes(current)) {
    return current === 'later' && (labels || []).includes(GO_LABEL) ? 'validated' : current;
  }
  if ((labels || []).includes(GO_LABEL)) return 'validated';
  return maxRelated ? 'pending' : 'auto';
}

/** A ticket can be merged only before it is queued: backlog, not promoted, not absorbed. */
export function mergeable(t) {
  return !!t && t.queue === 'backlog' && !t.merged_into
    && ['pending', 'later', 'auto'].includes(t.gate)
    && !(t.labels || []).includes(GO_LABEL)
    && !(t.merge && !t.merge.done_at);
}

/**
 * What merging `tickets` tickets saves, in plain words: each ticket costs one
 * fix round and one exam, so tickets - 1 of each. `problems` counts the blocks
 * (a ticket merged before brings all of its own).
 */
export function mergeSavings(tickets, problems = tickets) {
  const saved = Math.max(0, tickets - 1);
  if (!saved) return '';
  const s = saved === 1 ? '' : 's';
  return `Saves ${saved} fix round${s} and ${saved} exam${s}: one round and one exam cover ${problems === 2 ? 'both' : `all ${problems}`} problems.`;
}

const ticketNum = (key) => parseInt(String(key).split('-')[1], 10) || 0;

/** The ticket that survives a merge: the one asked for, else the oldest. */
export function pickSurvivor(keys, wanted) {
  if (wanted && keys.includes(wanted)) return wanted;
  return [...keys].sort((a, b) => ticketNum(a) - ticketNum(b))[0];
}

/**
 * The survivor's labels after a merge: its own, plus what the absorbed carry
 * (automation scope, claim-*, area-*), the highest severity only, and the
 * merged marker.
 */
export function mergedLabels(survivorLabels, absorbedLabels) {
  const all = [...(survivorLabels || []), ...absorbedLabels.flat()];
  const out = new Set((survivorLabels || []).filter((l) => !SEVERITIES.includes(l)));
  all.filter((l) => CARRIED_LABEL.test(l)).forEach((l) => out.add(l));
  const sev = SEVERITIES.find((s) => all.includes(s));
  if (sev) out.add(sev);
  out.add(MERGED_LABEL);
  return [...out];
}

/** The blocks a ticket brings to a merge: its own problem, or the ones it already merged. */
export function blocksOf(t, description) {
  if (t.merge?.blocks?.length) return t.merge.blocks;
  return [{
    key: t.key,
    title: t.title || '',
    text: typeof description === 'string' ? description : (t.excerpt || ''),
    claim_ids: [...new Set([...(t.claim_ids || []), ...claimIdsOfLabels(t.labels)])],
    links: t.links || [],
    max_related: !!t.max_related,
  }];
}

const cut = (text, max, key) => (text.length <= max
  ? text
  : `${text.slice(0, max).trimEnd()}\n\n_(cut here: the full text is on ${key})_`);

/**
 * The survivor's new Jira description (wiki markup): one block per problem,
 * each with its source, so the fix round and its exam cover every one.
 */
export function mergeDescription({ id, survivor, blocks, absorbedKeys, at, by }) {
  const n = blocks.length;
  const budget = Math.floor(DESCRIPTION_BUDGET / Math.max(n, 1)) - 400;
  const when = new Date(at).toISOString().slice(0, 10);
  const head = [
    `h2. One ticket, ${n} problems (merged from the admin cockpit)`,
    `Merged on ${when}${by ? ` by ${by}` : ''}. One fix round and one exam cover every problem below: fix each one, and the exam checks each one.`,
    `Absorbed tickets (labelled ${SUPERSEDED_LABEL}): ${absorbedKeys.join(', ')}.`,
    `cockpit-merge: ${id}`,
  ].join('\n');
  const body = blocks.map((b, i) => {
    const source = [
      b.key === survivor ? `${b.key} (this ticket)` : b.key,
      ...(b.claim_ids || []).map((c) => `claim ${c}`),
    ].join(' · ');
    const links = (b.links || []).length ? `\n*Evidence:* ${b.links.join(' , ')}` : '';
    return [
      '----',
      `h3. Problem ${i + 1} of ${n}: ${b.title || b.key}`,
      `*Source:* ${source}${b.max_related ? ' · drives MAX' : ''}${links}`,
      '',
      cut((b.text || '').trim() || '(no description)', budget, b.key),
    ].join('\n');
  });
  return [head, ...body].join('\n\n');
}

export const mergeComment = {
  survivor: ({ id, absorbedKeys, n }) => `Merged from the admin cockpit: this ticket now carries ${n} problems `
    + `(its own plus ${absorbedKeys.join(', ')}), one block each in the description. One fix round and one exam `
    + `cover all of them.\ncockpit-merge: ${id}`,
  absorbed: ({ id, survivor, index, n }) => `Merged into ${survivor} from the admin cockpit: this problem is block `
    + `${index} of ${n} there, fixed and checked in one round with the others. Closed as ${SUPERSEDED_LABEL}.`
    + `\ncockpit-merge: ${id}`,
};

export const gateComment = {
  validated: ({ tag, by }) => `Validated from the admin cockpit${by ? ` by ${by}` : ''}: label ${GO_LABEL} added, `
    + `the ticket may enter the fix queue (one fix round and one exam).\ncockpit-gate: ${tag}`,
  dismissed: ({ tag, by, note }) => `Declined from the admin cockpit${by ? ` by ${by}` : ''}: not fixed, closed.`
    + `${note ? `\nReason: ${note}` : ''}\ncockpit-gate: ${tag}`,
};
