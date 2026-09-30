---
name: ui-review
description: Rendered UI verification — capture the running interface at mobile and desktop widths, run automated UI checks, have the product-designer review real screenshots, fix in one pass. Use for ui-significant tasks at the review step, or whenever a UI change must be seen rather than read.
---

# UI Review

What users see is the evidence. Reviewing UI code without seeing it rendered is not UI review.

## 1. Render

1. Start the app, or use a running instance, and confirm that its URL responds.
2. Seed realistic local data so screens aren't empty, unless you are checking empty states.
3. For pages behind login, write a small setup module that signs in a local test user. Its default
   export is `async ({ page, baseURL }) => {}`. Use test credentials only.

## 2. Capture and Check (web)

```
node .claude/tools/ui-capture.mjs --url <base> --routes home,settings,... \
     --out .engineering/ui-review/<task-id> [--dark] [--setup <file>]
```

- Write routes without a leading slash; Git Bash rewrites a bare `/`.
- The tool saves full-page screenshots at 375, 768 and 1440 px (plus dark mode) and a
  `report.json` covering:
  - overflow;
  - low contrast;
  - unlabeled controls;
  - missing `alt` text;
  - small touch targets;
  - console errors and failed requests.
- It uses the project's Playwright. If Playwright is missing, and the task permits adding a dev
  dependency, install it (`npm i -D playwright`, `npx playwright install chromium`). Otherwise use
  an available browser tool.
- **Native or mobile apps:** use simulator or emulator screenshots.
- **Nothing can render:** report the visual result as **Not verified**.

## 3. Fix the Mechanical Findings First

Overflow, labels, contrast and console errors need no designer. Fix them through
`software-engineer`, then re-capture only the affected routes.

## 4. Designer Review

Invoke `product-designer` (Mode 2) with:

- the spec path;
- the screenshot folder and the report path;
- at most ~12 images named: mobile and desktop of each changed screen, plus dark mode of the most
  important ones.

The designer returns APPROVE or CHANGES REQUIRED.

## 5. One Correction Pass

1. Fix the CRITICAL, HIGH and MEDIUM findings, and the LOW ones when they are cheap.
2. Re-capture the changed screens with `--strict`, so that remaining automated findings exit
   non-zero.
3. Hold a second designer round only if a HIGH remains.

## 6. Evidence

Record these in the ledger's Verification and Reviews:

- the verdict;
- the finding counts;
- what was fixed;
- the screenshot folder.

The folder `.engineering/ui-review/` is git-ignored.
