<h1 align="center">dsh-agent-team-scheduler</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh.md">简体中文</a>
</p>

<p align="center">DeepSeek Harness Agent Teams 的派工队列，由人开启。</p>

Lead 登记任务。人打开队列。就绪的工作分给空闲 teammate，写入范围重叠的任务不会同时跑。

- **人来开启：** `/dispatch on` 才开始。模型不能自己打开。
- **有上限：** 默认同时最多两个由 teammate 负责的任务。用 `/dispatch wip <n>` 修改。
- **按范围错开：** 写入范围重叠就等待。没写范围也等待，除非任务是只读。
- **不自动重试：** 成员停下来不算完成。投递结果不确定时不重发。
- **重启即暂停：** 再次 `/dispatch on` 之前不会派发。

## 开始使用

### 前置条件

- DeepSeek Harness `>=0.2.1-rc.5 <0.3.0`
- 同一 profile 已开启 Agent Teams

### 插件

在 dsh 里打开 **Plugins → Install a third-party plugin**，输入 `dsh-agent-team-scheduler`。或者在终端：

```bash
dsh plugin --profile web add dsh-agent-team-scheduler
```

安装到 `desktop` profile 前先退出 Desktop。重启 dsh。在 Team Lead 会话里：

```text
/dispatch on
/dispatch status
/dispatch off
/dispatch wip <n>
```

Lead 用 `team_dispatch_set` 登记任务。

## 限制

只在一个进程内有效。Lead 必须在线。写入范围是提示，不是锁。插件不会创建 teammate 或 worktree。

## 开发

```bash
npm ci
npm run typecheck
npm run build
npm test
```

## 许可证

MIT。与 DeepSeek 无关。
