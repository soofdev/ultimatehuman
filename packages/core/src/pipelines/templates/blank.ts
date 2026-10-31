import type { BriefId } from "../../instructions/instructions";

/** The skeleton a blank pipeline starts from: valid, deliberately short, meant to be rewritten. */
export const BLANK_BRIEFS: Record<BriefId, string> = {
  mission: `# Mission

Describe what this pipeline looks for, and what one ticket from it is.
Decide whether the cluster in front of you is a real problem worth a human's time, and if it is, what causes it.
`,
  collector: `# Investigation checklist

- Read cluster.md, then every evidence file it lists.
`,
  admission: `---
# Users-affected floor: a cluster touching fewer distinct people is dropped before any agent runs. 0 = no floor.
minUsersAffected: 1
---
# Admission rules

- Precision over recall: answer "no_finding" when the evidence is weak.
`,
  gate: `# Gate verdict policy

Try hard to BREAK the draft. Does each claim follow from the cited evidence? Is there a simpler explanation?
- "holds": supported as written. "partly": real but overstated; give the corrected fields in "rewrite". "broken": not supported.
`,
  scope: `# Scope

- In scope: describe it.
- Out of scope: describe it.
`,
};
