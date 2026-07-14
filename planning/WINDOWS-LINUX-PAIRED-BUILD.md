# Windows and Linux Paired-Build Protocol

This is the binding coordination contract for the Windows validation lane and
the Codex01 Linux-first build lane. An implementation wave does not begin until
its clean base can be identified exactly; a validation wave does not begin
until its clean candidate can be reproduced on both machines.

## Wave packet

Every wave delegation must contain:

- wave ID
- phase: `implementation`, `validation`, or `package-install`
- source branch and full base SHA for implementation
- candidate branch and full candidate SHA for validation
- exact npm version plus registry identity and released handoff for package install
- exact scope
- explicit, non-overlapping file ownership
- acceptance commands for Windows and Linux
- known risks

Missing phase-appropriate information stops the wave. Do not infer a base or
candidate from a branch name, package version, dirty checkout, or most recent
local build.

## Lane ownership

- Linux is the default construction lane. It owns platform-neutral
  implementation, refactors, deep debugging, primary automated testing,
  PTY/TUI work, Linux-specific fixes, and parallel worker/harness execution.
- Windows is the quality-and-coordination controller. It owns the controlling
  handoff state, exact candidate/release identity, Windows-specific
  implementation, Windows Terminal, installed-build, and daily-driver
  validation. It does not duplicate platform-neutral Linux work.
- A failure returns to Linux by default unless evidence isolates it to Windows.
- The two lanes must not edit the same file in one wave. If evidence requires a
  file to change owners, stop and issue a revised wave packet before editing it.
- Builders make local source, test, and handoff changes only. The reviewer owns
  clean candidate commits, branches, pushes, PRs, and CI coordination.

## Source identity gate

Linux works from a clean ext4 worktree under /home/codex/worktrees. Before any
install, test, link, or edit, verify both the exact SHA and a clean worktree:

~~~bash
expected_sha="<base-or-candidate-sha>"
test "$(git rev-parse HEAD)" = "$expected_sha" || {
  echo "STOP: candidate SHA mismatch"
  exit 1
}
test -z "$(git status --porcelain)" || {
  echo "STOP: candidate worktree is dirty"
  exit 1
}
~~~

A stale or dirty-source mismatch is a STOP condition, not permission to relink
guru. An implementation wave may edit after this clean-base check and may use a
review-red SHA specifically to correct its findings. A validation wave remains
clean at the exact candidate SHA. Never relabel a review-red base or dirty
working tree as an approved candidate.

## Working loop

1. The controller or reviewer sends Linux an implementation packet containing
   the exact clean base SHA, newest review findings, scope, ownership, commands,
   and risks.
2. Linux verifies the base, assigns non-overlapping worker ownership, performs
   the platform-neutral implementation, and runs focused plus full checks.
3. Linux records exact commands/results in the review exchange and preserves
   the ext4 worktree for a reviewer on Codex01. The reviewer cleans the delta,
   commits and pushes it, then reports a new candidate branch and full SHA.
4. Linux creates or refreshes a clean validation worktree at that candidate and
   runs Node 24, build, full tests, local-link, PTY/TUI, and requested smoke
   checks.
5. Windows fetches the same candidate SHA, runs relevant automated checks,
   `npm run dev:sync`, and Windows Terminal/daily-driver validation.
6. Any failure returns to Linux as a minimal repro unless it is proven
   Windows-specific. The appropriate lane fixes it and the reviewer emits a new
   candidate SHA before validation repeats.
7. Do not advance while a dependent check is red or the two platforms differ.

## Promotion gate

Only a candidate green on the same SHA on Windows and Linux may advance to:

1. separate peer review
2. PR review
3. repo-hygiene and CodeQL
4. package-tarball installation and smoke testing

Routine waves do not bump versions, publish packages, or create releases.
The current release target is 1.5.1 and may publish only after every gate passes.
Later dogfood releases remain on 1.5.x for as long as needed (1.5.1, 1.5.2, …);
1.6.0 or higher is prohibited until Matthew explicitly says Guru is working well
enough to advance. CI and the release workflow enforce the 1.5.x ceiling.

## Published npm synchronization

Published package installation is a distinct coordinated wave, not an
independent platform update:

1. Windows detects the released handoff and resolves the exact published
   `guruharness@<version>` plus npm registry identity such as `dist.integrity`
   and `gitHead` when available. The version must remain on 1.5.x unless Matthew
   explicitly authorizes otherwise.
2. Windows sends Linux a package-install packet containing that identity and
   waits for Linux to acknowledge an install window. Do not interrupt an active
   source-build command or silently replace its development link.
3. Linux records its current global package/link target, installs the exact
   package version, runs `guru --version` and the package smoke, and reports
   PASS/FAIL. A Linux failure stops the Windows install.
4. After Linux passes, Windows installs and verifies the same exact version and
   records its package/link state and smoke results.
5. Linux may restore `npm run dev:install` for active source development only
   after its package result is recorded. It must report the restored worktree
   path and SHA. Windows may keep the released package for daily-driver use,
   but its active state must also remain explicit.
6. Append one coordinated handoff containing the exact package identity, both
   platform results, and final active link/package states. Never publish, tag,
   or infer a release from this install wave.

## Communication

The canonical review exchange is P:\guruharness\handoffs\code-reviews. Builders
place sanitized candidate evidence there and read the newest applicable
reviewer verdict before continuing. Reviewer reports are append-only; a red or
changes-required verdict drives corrective work to Linux but blocks validation
as a promotion candidate, promotion, and publishing. A later report for a new
exact SHA must explicitly clear that gate.

Check in at these event boundaries:

- candidate ready
- failure found
- fix ready
- platform gate green
- published npm version detected
- Linux package smoke complete
- Windows package smoke complete

For work lasting more than 30 minutes, send a short heartbeat containing the
current SHA, active command, and blocker. Avoid duplicate polling and duplicate
work between lanes.
