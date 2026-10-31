<h1 align="center">dsh-agent-team-scheduler</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">A dispatch queue for DeepSeek Harness Agent Teams, armed by a person.</p>

The Lead enrolls tasks. A person starts the queue. Ready work goes to idle teammates, and overlapping write scopes do not run together.

- **Human armed:** `/dispatch on` starts it. The model cannot.
- **Bounded:** At most two teammate-owned tasks run at once. Change it with `/dispatch wip <n>`.
- **Isolated by hint:** Overlapping write scopes wait. A missing scope waits unless the task is read-only.
- **Not a retry loop:** An inactive owner is not done. An uncertain delivery is not sent again.
- **Paused on restart:** Dispatch stays off until `/dispatch on` again.

## Getting Started

### Prerequisites

- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`
- Agent Teams enabled in the same profile

### Plugin

In dsh, open **Plugins → Install a third-party plugin** and enter `dsh-agent-team-scheduler`. Or from the terminal:

```bash
dsh plugin --profile web add dsh-agent-team-scheduler
```

Quit Desktop before installing into the `desktop` profile. Restart dsh. In a Team Lead session:

```text
/dispatch on
/dispatch status
/dispatch off
/dispatch wip <n>
```

The Lead enrolls a task with `team_dispatch_set`.

## Limits

One process. The Lead must be live. Write scopes are hints, not locks. The plugin does not create teammates or worktrees.

## Development

```bash
npm ci
npm run typecheck
npm run build
npm test
```

## License

MIT. Not affiliated with DeepSeek.
