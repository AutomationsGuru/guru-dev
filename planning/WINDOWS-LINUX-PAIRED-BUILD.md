# Windows and Linux Paired-Build Protocol

This is the binding coordination contract for the Windows integration lane and
the Codex01 Linux builder. A wave does not begin until its candidate can be
identified and reproduced exactly on both machines.

## Wave packet

Every wave delegation must contain:

- wave ID
- candidate branch and full candidate SHA
- exact scope
- explicit, non-overlapping file ownership
- acceptance commands for Windows and Linux
- known risks

Missing information stops the wave. Do not infer a candidate from a branch
name, a package version, a dirty checkout, or the most recent local build.

## Lane ownership

- Windows owns integration, product dogfood, and Windows Terminal validation.
- Linux owns ext4 Node 24 bootstrap, deep tests and debugging, PTY/TUI parity,
  and Linux-specific fixes assigned in the wave packet.
- The two lanes must not edit the same file in one wave. If evidence requires a
  file to change owners, stop and issue a revised wave packet before editing it.
- Builders make local source, test, and handoff changes only. The reviewer owns
  clean candidate commits, branches, pushes, PRs, and CI coordination.

## Candidate gate

Linux works from a clean ext4 worktree under /home/codex/worktrees. Before any
install, test, link, or edit, verify both the exact SHA and a clean worktree:

~~~bash
expected_sha="<candidate-sha>"
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
guru. Preserve stale clones as historical evidence until a clean candidate is
available.

## Working loop

1. Windows finishes the assigned integration work and acceptance commands.
2. The reviewer exposes that exact working state as a clean candidate branch
   and SHA.
3. Windows sends Linux a wave packet with that SHA and the required checks.
4. Linux verifies the SHA and clean state, then runs the assigned Node 24,
   build, test, link, and PTY/TUI checks.
5. Linux reports exact commands, PASS/FAIL, minimal repro evidence,
   guru --version output, resolved global link target, and TUI results.
6. A Linux failure returns to Windows as a minimal repro. Windows fixes its
   owned files, the reviewer produces a new candidate SHA, and Windows
   re-delegates the wave.
7. Do not advance while a dependent check is red.

## Promotion gate

Only a candidate green on the same SHA on Windows and Linux may advance to:

1. separate peer review
2. PR review
3. repo-hygiene and CodeQL
4. package-tarball installation and smoke testing

Routine waves do not bump versions, publish packages, or create releases.
The current release target is 1.5.1 and may publish only after every gate passes.
Later dogfood releases remain on 1.5.x; 1.6.0 or higher is prohibited until
Matthew explicitly says Guru is working well enough to advance.

## Communication

Check in at these event boundaries:

- candidate ready
- failure found
- fix ready
- platform gate green

For work lasting more than 30 minutes, send a short heartbeat containing the
current SHA, active command, and blocker. Avoid duplicate polling and duplicate
work between lanes.

## Wave 0 prerequisite

Wave 0 begins only after the reviewer exposes the current Windows working state
as a clean candidate branch and SHA. Until that event, Linux preserves its
stale 1.3.0 clone and does not treat it as current or relink guru to it.
