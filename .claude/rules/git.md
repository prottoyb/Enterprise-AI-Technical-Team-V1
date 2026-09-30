# Git Standards

## Start of Every Task

Record the current branch, the `git status` and the canonical branch in the ledger (discovery shows
all three). Existing uncommitted changes belong to the human:

- never discard, stash-drop, reset or overwrite them;
- never commit them as part of your work;
- if they overlap the files you must change, stop and ask.

## Branches and Commits

- Work on a branch named `fix/`, `feature/`, `refactor/`, `chore/`, `docs/`, `test/` or
  `hotfix/<task-id>-<slug>`. Create it from the current HEAD unless the task says otherwise.
- Commit locally at meaningful checkpoints of multi-step work. Local commits need no approval.
- Commits are coherent and use Conventional Commits style. They contain only the task's changes:
  no secrets, local config, build artifacts or temporary files. Stage explicit paths, never
  `git add -A` over a tree that holds other people's work.
- Keep AI-authored changes distinguishable from pre-existing ones, via the ledger's Changes
  section and the commit contents.

## Gated (Human Approval)

These need approval:

- pushing or opening a PR (the task request may pre-authorise this);
- merging, tagging and releasing (live approval only);
- anything that rewrites shared history.

The `git-guard` hook blocks, without exception:

- pushes to the canonical branch;
- every force push;
- `reset --hard`, `clean -f`, `checkout -- <path>`, `restore` of the working tree, `branch -D`,
  `stash drop/clear`, `filter-branch`, `reflog expire` and `gc --prune=now`.

If one of these is genuinely needed, the human runs it themselves.

Safe alternatives:

| Instead of | Use |
|---|---|
| `reset --hard` | `git stash` (kept), `git revert`, or a new commit |
| `branch -D` | `branch -d` |
| discarding your own change | revert it with an edit |

## Parallel Work

Parallel implementers get `isolation: "worktree"` when the lead invokes them. A worktree starts
from the default branch, so the lead commits first and names the base revision in the packet. The
engineer verifies it with `git merge-base --is-ancestor <base> HEAD`, and fast-forwards if needed.
The lead owns merging parallel branches.

## Before Reporting

Inspect `git status` and the final diff against the base. List every changed file in the ledger,
and flag any file that was changed unexpectedly.
