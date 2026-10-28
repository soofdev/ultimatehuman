// TEACH-n cards on the vendored Pipeline page (app/, verbatim-locked). The vendored
// DecisionCard renders context as plain strings and its AnswerStatus speaks of fixes, so
// this layer adds what a proposal needs on top of the rendered card, without editing app/:
// - the proposal's change as the red/green Diff of Config > Instructions, under the question;
// - the answer line in proposal words instead of "The fix resumes on the next pipeline run."
import { createRoot } from 'react-dom/client';
import { Diff } from './InstructionsPage';

// The vendored AnswerStatus sentences (CockpitClient.js), replaced on TEACH cards only.
const FIX_COPY = new Set(['Posted on the ticket. The fix resumes on the next pipeline run.', 'The pipeline picks it up within 15 minutes.']);
const CARD = '[data-ticket-card^="TEACH-"], [data-phone-card][data-ticket^="TEACH-"]';
const mounted = new Map(); // container -> React root

/** `proposalOf(key)` gives the proposal behind a TEACH key, `answerCopy(key)` the sentence for its last answer. */
export function enhanceTeachCards({ proposalOf, answerCopy }) {
  const sweep = () => {
    for (const card of document.querySelectorAll(CARD)) {
      const key = card.getAttribute('data-ticket-card') || card.getAttribute('data-ticket');
      for (const p of card.querySelectorAll('[data-answer-status] > p')) {
        const last = p.lastChild;
        if (last?.nodeType === 3 && FIX_COPY.has(last.nodeValue)) last.nodeValue = answerCopy(key);
      }
      const proposal = proposalOf(key);
      const question = card.matches('[data-ticket-card]') && card.querySelector(':scope > [data-question]');
      if (!proposal || !question || card.querySelector(':scope > [data-teach-diff]')) continue;
      const box = document.createElement('div');
      box.setAttribute('data-teach-diff', key);
      box.className = 'mt-3';
      question.after(box);
      const root = createRoot(box);
      root.render(<Diff lines={proposal.diff} file={`${proposal.brief}.md: the proposed change`} />);
      mounted.set(box, root);
    }
    for (const [box, root] of mounted) if (!box.isConnected) { root.unmount(); mounted.delete(box); }
  };
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; sweep(); });
  };
  new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  later();
}
