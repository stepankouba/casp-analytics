---
name: casp-analytics-no-tests
description: casp-analytics has no tests or lint; how to verify a build and frontend change without adding dependencies
metadata:
  type: project
---

The repo has no test runner and no linter (only build scripts in `package.json`), and no README.

**Why:** It grew as a data-pipeline plus vanilla-JS static site; the build itself is the only gate.

**How to apply:** Verify with `SKIP_SCRAPE=true SKIP_LLM=true npm run build` (a full build would
re-scrape and call the Anthropic API; the cache in `build/cache/` is expensive to lose). For UI
logic, a minimal DOM stub script in the scratchpad (getElementById/querySelector over the `id`
attributes parsed out of `src/index.html`, plus `fetch`/`gtag`/`Chart` stubs, then `new Function`
over `src/*.js`) catches runtime errors and empty states without installing jsdom. A rebuild also
rewrites `docs/` — restore with `git checkout -- docs` if the rebuild was only a check.
