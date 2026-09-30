---
name: root-cause-analysis
description: Evidence-driven debugging procedure — reproduce, isolate, hypothesise, prove, and separate symptom from immediate failure from root cause. Preloaded into the investigator; also usable directly when diagnosing any defect, regression, flaky test, performance problem or CI/production-like failure.
---

# Root-Cause Analysis

The goal is a **proven** cause and the smallest correct fix, not the first plausible story.

## 1. Frame

- State the symptom exactly: what happens, what should happen, where, since when.
- Collect the evidence given, such as errors, logs, screenshots and steps. Read prior handoffs, and
  don't redo what they established.
- If a "last known good" exists (a version, a commit, a date), note it: it enables bisection.

## 2. Reproduce

- Reproduce with the smallest reliable case: a failing test, a script, or a request against a local
  instance. Put scratch files in `.engineering/tasks/<ID>/scratch/`.
- Record the exact command and the observed output.
- If you cannot reproduce it, record what you tried and the environment differences. Continue by
  reasoning from code and logs, and label conclusions INFERRED. Never claim a reproduction you did
  not see.

## 3. Isolate

Narrow the failing path, working from the symptom backwards:

- **Trace:** the entry point → the layers → the point where actual and expected diverge.
- **Bisect:** use `git log -- <paths>` for recent changes to the area, then `git bisect` with a
  scripted test when a known-good revision exists. End it with `git bisect reset`.
- **Compare state:** inputs, configuration, data, versions and environment, working versus failing.
- **Instrument:** add temporary logging or asserts in scratch copies, or through a debugger, not
  committed code.

## 4. Hypothesise and Test

List two or three candidate causes. For each, give a prediction you can check ("if X, then Y should
also happen"). Run the check. Rule hypotheses out explicitly, and keep that record: it saves the
reviewer from re-asking.

Beware these false causes:

- the line that throws (often the victim, not the culprit);
- the most recent commit;
- a coincident environment change;
- documentation that disagrees with the code.

## 5. Establish the Chain

```
Symptom            what the user sees
Immediate failure  the operation that goes wrong (file:line)
Root cause         the defect that makes it go wrong (file:line) — and why it was possible
                   (missing validation, missing test, wrong assumption, race)
```

The fix belongs at the root cause. Consider whether the same cause affects other paths: search for
siblings of the faulty pattern.

## 6. Recommend

- The smallest correct fix, and why it is at the cause and not the symptom.
- The regression test that fails today and will pass after the fix.
- The blast radius: the callers and data affected. Say whether a data repair is needed (a
  `data-destructive` concern, with approval).
- Your confidence, and what would raise it.

## Special Cases

- **Flaky test:**
  1. Run it repeatedly (at least 20 times, or until it fails) and record the failure rate.
  2. Look for shared state, ordering, time and timezone, randomness, concurrency, and external
     calls.
  3. Prove the fix with the same repeat count.
- **Performance:**
  1. Measure first: the baseline, with the same data and environment.
  2. Profile to find where the time or memory actually goes.
  3. Only then hypothesise. Report the before and after numbers from the same method.
- **CI-only failure:** diff the CI environment against local (versions, env vars, parallelism,
  file-system case, time zone). Reproduce using the CI's commands.
