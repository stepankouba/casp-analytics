---
name: casp-analytics-changes-baseline
description: In casp-analytics the published version baseline is the last committed docs/data/app.json; the "What's new" tab was added 2026-09-26 on top of it
metadata:
  type: project
---

The "What's new" tab (added 2026-09-26) compares the current data against the last **committed**
`docs/data/app.json`, because a commit is what gets published to GitHub Pages. The diff is computed
at build time by `build/04b-compute-changes.js` (`DIFF_BASE_REF` overrides the baseline).

**Why:** Štěpán wanted users to see which CASPs were newly registered, without adding a snapshot
history or any runtime dependency to the static app.

**How to apply:** Any future change-tracking work here belongs in that step, not in a new storage
layer. Only registry fields count as a change (services, passporting, auth_end_date, home_country);
LLM enrichment fields are noise from re-classification. Be careful when committing a rebuild: after
a commit the next diff is against that commit, so a rebuild right after committing shows zero
changes. See [[casp-analytics-no-tests]].
