# dsh-agent-team-scheduler

DeepSeek Harness 插件：把 Agent Teams 任务板变成由人开启的派工队列。

先开启 **Agent Teams**。没开时本插件会保持 pending。

## 做什么

- Lead 用 `team_dispatch_set` 登记任务（优先级、截止时间、auto/manual、只读、优先成员）。
- 只有人能用 `/dispatch on` 开始派发，模型不能自己打开队列。
- 就绪、无人认领、标记 auto 的任务，在 WIP 上限内（默认 2）分给空闲 teammate。
- 写入范围重叠的任务不会同时派。没写范围默认推迟，除非标成只读。`.` 和 `/` 视为整个工作区。
- 创建失败的成员名下的任务会释放。成员只是 inactive **不算完成**，只通知 Lead，不收回任务。
- 消息可能已经进了持久邮箱时，不会自动重发。要重试，重新登记该任务。
- 进程重启后队列暂停，直到再次 `/dispatch on`。

## 命令

```text
/dispatch on
/dispatch off
/dispatch status
/dispatch wip <n>
```

## 安装

先开启 Agent Teams，再安装已发布的 npm 包。

插件页：**Add package**，输入 `dsh-agent-team-scheduler`。

命令行（目标是 `desktop` profile 时，先完全退出 Desktop）：

```sh
dsh plugin --profile <profile> add dsh-agent-team-scheduler
```

## 限制

只在单进程内有效。Lead 必须在线。写入范围只是提示，不是锁。不会自动新建 teammate，也不会自动建 worktree。
