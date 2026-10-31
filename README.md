# dsh-agent-team-scheduler

A DeepSeek Harness plugin that turns the Agent Teams task board into a human-armed dispatch queue.

Enable **Agent Teams** first. This plugin stays pending until that bundle is on.

## What it does

- The Lead enrolls tasks with `team_dispatch_set` (priority, deadline, auto/manual, read-only, preferred teammate).
- A human starts dispatch with `/dispatch on`. The model cannot arm the queue.
- Ready, unowned, auto tasks are assigned to idle teammates within a WIP limit (default 2).
- Tasks with overlapping write scopes are not assigned at the same time. A missing write scope is deferred unless the task is marked read-only. `.` and `/` count as the whole workspace.
- A failed member's task is released. An inactive owner is **not** treated as done; the Lead is notified and ownership stays.
- If a brief may already have been queued, the scheduler does not retry it. Re-enroll the task to clear that hold.
- Restart pauses dispatch until `/dispatch on` again, even if the log was armed.

## Commands

```text
/dispatch on
/dispatch off
/dispatch status
/dispatch wip <n>
```

## Install

Enable Agent Teams, then install the published npm package.

Plugins page: **Add package**, then enter `dsh-agent-team-scheduler`.

CLI (quit Desktop first when targeting the `desktop` profile):

```sh
dsh plugin --profile <profile> add dsh-agent-team-scheduler
```

## Limits

Single process. The Lead must be live. Write scopes are hints, not locks. No automatic teammate creation and no worktree isolation.
