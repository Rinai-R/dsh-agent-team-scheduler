# dsh-agent-team-scheduler — v0.1 implementation spec

Target runtime: DeepSeek Harness 0.2.1-rc.5 with the Agent Teams bundle (`@deepseek-ai/dsh-experimental-agent-team-profile`) enabled.
API evidence: [research/api-findings.md](research/api-findings.md). Packaging: [research/packaging-findings.md](research/packaging-findings.md).

## 1. What it does

A host plugin that turns the Agent Teams task board into a dispatch queue for one Lead session:

- picks `pending` + `ready` + unowned tasks that are marked for automatic dispatch;
- orders them deterministically (no model call);
- assigns them to idle teammates within a WIP limit (`updateTask` `reassign` + `sendMessage` brief);
- never runs two tasks with overlapping write scopes at the same time;
- releases tasks owned by failed members;
- reports every decision to the Lead as a durable notice that does not start a turn;
- dispatches only after a **human** armed the queue with a slash command.

Non-goals for v0.1: auto-spawning teammates, worktree creation, UI panel, cross-process scheduling, deadlines reminders.

## 2. Module layout

```
src/
  index.ts        plugin entry: name, inject, Config, apply
  types.ts        types only (records, projection state, config)
  records.ts      plugin record types + hand-written validators + append helpers
  state.ts        per-Lead in-memory DispatchState: built once from the Lead log, updated on our own appends
  policy.ts       PURE functions: candidate selection, ordering, scope overlap, member choice, stall/failed detection
  scheduler.ts    per-Lead tick orchestration (side effects through injected ports)
  notices.ts      batching + rendering of Lead notices
  command.ts      /dispatch human command
  tools.ts        team_dispatch_set / team_dispatch_status model tools
tests/            vitest, one spec per module; policy.ts must have exhaustive table tests
```

`policy.ts` must not import any dsh runtime value; it works on plain data so it is fully unit-testable.

## 3. Plugin entry

```ts
export const name = 'agent-team-scheduler'
export const inject = ['agents', 'agentTeams', 'sessionProjections', 'sessionQuery', 'commands', 'tools']
export interface Config {
  maxActive: number            // default 2, min 1, integer
  defaultDispatch: 'manual' | 'auto'  // default 'manual': tasks without metadata are ignored
  requireWriteScopes: boolean  // default true: a non-readOnly task with empty writeScopes is deferred
  debounceMs: number           // default 200, min 0
  noticeMaxItems: number       // default 20: max decision lines per notice
}
```

Config with `@deepseek-ai/schemastery` (`z.object({...})`), exported both as interface and `export const Config: z<Config>`.

`apply(ctx, config)`:
1. (no projection in v0.1)
2. Register `/dispatch` command (`ctx.commands.register`).
3. Install tools on Team members exactly like tool-agent-team: for every `ctx.agents.list()` and on `agent/created`, if `ctx.agentTeams.tryMembership(agent)` is defined → `agent.ctx.tools.register(defineTool(...))`; dispose on `agent/disposed`; all members get identical schemas, Lead role checked at execute.
4. Triggers → `scheduleTick(leadId)` (debounced per Lead, never synchronous inside listeners; use `setTimeout(debounceMs)`; one in-flight tick per Lead, a trigger during a tick sets a `rerun` flag):
   - `ctx.root.sessionProjections.onChanged((session, key) => key === 'agentTeam')` → lead = session id (check the exact rc.5 signature and that the returned disposer is registered as an effect);
   - `ctx.on('agent/status', ({ agent }))` → if agent is a teammate, lead = `membership.root.id`; if a Lead, lead = agent.id;
   - `ctx.on('agent/created', ({ agent }))` for a Lead → tick (resume after restart).
5. Dispose: clear timers, abort in-flight ticks (AbortController per Lead).

## 4. Durable state (plugin records in the Lead session)

Never use `SessionEventMap` + `append()` (unknown event types make sessions unloadable). Use `appendPluginRecord(session, type, data)` from `@deepseek-ai/dsh-session`, declared through `PluginRecordMap` merging:

```ts
'plugin:dsh-agent-team-scheduler/control': { version: 1; armed: boolean; maxActive?: number; actor: 'human' }
'plugin:dsh-agent-team-scheduler/item': {
  version: 1; taskId: string
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  deadline: string | null          // normalized ISO 8601 (new Date(v).toISOString())
  dispatch: 'auto' | 'manual'
  readOnly: boolean
  preferredMember: string | null
}
'plugin:dsh-agent-team-scheduler/decision': {
  version: 1; taskId: string
  kind: 'dispatched' | 'deferred' | 'released' | 'stalled' | 'failed'
  member: string | null; reason: string
}
```

Validate `data` with small hand-written validators on read (records may come from other versions); invalid records are skipped and counted in `diagnostics`. Do NOT depend on `zod` (it is not a `@deepseek-ai` host peer and may not resolve for a `link:` install).

## 5. Per-Lead state (`state.ts`, no projection in v0.1)

No custom Session projection (it would need a zod `stateSchema`). Instead keep an in-memory `DispatchState` per Lead id:

- built lazily on first use from `ctx.sessionQuery.observeSession(leadId, { projectionMode: 'none' })` (dispose the observation): fold `pluginRecordOf(event)` for our record types, in seq order;
- `control` records with `seq < observation.inheritedEventCount` are ignored (a forked root must not inherit "armed"); `item` records inherited are kept;
- after each successful `appendPluginRecord` we apply the same record to the cached state;
- the cache entry is dropped on `agent/disposed` of the Lead and on `agent/created` with source `clear` (rebuild next time).

```ts
interface DispatchState {
  armed: boolean
  maxActive: number | null           // override from /dispatch wip <n>
  items: Record<string, DispatchItem> // by taskId, last record wins
  lastDeferred: Record<string, string> // taskId -> last deferred reason (for dedupe)
  diagnostics: number
}
```

The fold function must be pure and unit-tested.

## 6. Tick algorithm (`scheduler.ts` + `policy.ts`)

```
lead = ctx.agents.get(leadId); if !lead → stop (Lead cold)
if tryMembership(lead)?.role !== 'lead' → stop
state = await dispatchState(leadId); if !state.armed → stop
team  = stateOf(lead.session, 'agentTeam')   // raw: tasks with ownerId, members with phase
tasks = agentTeams.listTasks(lead); members = agentTeams.listMembers(lead)

1. failed owners: for each in_progress task whose ownerId is a member with status 'failed'
     → updateTask(reassign, no owner) → decision 'released'
2. stalls: for each in_progress task owned by a teammate whose status is 'inactive'
     and we have not reported a stall for this (taskId, revision) → decision 'stalled' (no state change)
3. active = count in_progress tasks owned by teammates (any origin)
   limit  = state.maxActive ?? config.maxActive
4. candidates = tasks where status pending && ready && no owner &&
     (item?.dispatch ?? config.defaultDispatch) === 'auto'
   order: priority asc (P0 first; missing item → P2) → deadline asc (null last) → task number asc
5. for c in candidates while active < limit:
     scope check (unless readOnly): requireWriteScopes && scopes empty → defer "no write scopes";
       overlap with any in_progress task or any task assigned earlier in this tick → defer "overlaps task-x"
     member = preferredMember if idle else first idle teammate in roster order
       idle = role teammate && status 'inactive' && phase active && owns no in_progress task
              && not assigned earlier in this tick
       none → defer "no idle teammate"
     dispatch:
       updateTask(lead, { taskId, expectedRevision: c.revision, action: 'reassign', owner: member.name })
         TEAM_TASK_STALE_REVISION / TEAM_TASK_BLOCKED → skip silently (next tick re-reads)
       sendMessage(lead, { target: member.name, content: brief(c), signal })
         failure → updateTask(reassign, no owner) compensation → decision 'failed'
       decision 'dispatched'; active += 1
6. append decision records (only when changed: a deferred reason equal to lastDeferred[taskId] is not re-recorded)
7. if any decision lines → one notice to the Lead (section 7)
```

Scope overlap = copy agent-team logic: normalized paths, equal or one is a path-prefix of the other (`a === b || b.startsWith(a + '/') || a.startsWith(b + '/')`); normalize like agent-team `writeScope()` (trim, strip leading `./`, trailing `/`).

Brief text (English, model-facing, stable, snapshot-tested):

```
Scheduled task <id>: <subject>
<description>
Write scopes: <scopes or "none (read-only)">
You are assigned as owner. Work only inside the write scopes above. When finished, mark the task complete with team_task_update and send the result summary to lead with send_message.
```

## 7. Lead notices (`notices.ts`)

`lead.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'team-dispatch', form: 'notice', summary } }))` — durable, does not start a turn. Declare `'team-dispatch'` in `MessageSourceMap` of `@deepseek-ai/dsh-llm` (copy agent-team/tool-jobs pattern). One notice per tick, at most `noticeMaxItems` lines + "(n more)". Text: `Dispatch queue: task-3 → api-dev (dispatched); task-5 deferred: overlaps task-3 …`.

## 8. Human command `/dispatch`

`ctx.commands.register({ name: 'dispatch', description, input: { hint: 'on | off | status | wip <n>' }, handler })`:
- target `invocation.agent` must be a Lead (`tryMembership`), else `{ kind: 'error' }`;
- `on` / `off` → append control record `{ armed, actor: 'human' }`, schedule tick;
- `wip <n>` → control record with `maxActive: n` (keeps armed value);
- `status` / empty → text summary (armed, WIP n/limit, ordered candidates, last deferred reasons).
No model turn. The model never gets an arming capability.

## 9. Model tools (Lead-only at execute, installed for all members)

- `team_dispatch_set` params `{ task_id: string (required), priority?: 'P0'|'P1'|'P2'|'P3', deadline?: string, dispatch?: 'auto'|'manual', read_only?: boolean, preferred_member?: string }` → validates task exists (`getTask`), merges with current item, appends item record; returns `{ task_id, priority, deadline, dispatch, read_only, preferred_member }`.
- `team_dispatch_status` no params → `{ armed, active, limit, queue: [{ task_id, priority, deadline, dispatch }], deferred: [{ task_id, reason }] }`.
Description must say that only a human can start dispatching (`/dispatch on`).
Output via `jsonOutput`-like render: compact `JSON.stringify(value)`.

## 10. Tests (vitest)

- policy: ordering, defaults, scope normalization/overlap table, empty scopes, readOnly bypass, WIP limit, preferred member, idle detection, same-tick exclusions.
- scheduler with fake ports: not armed → no calls; Lead cold → no calls; CAS stale → skip; send failure → compensation; failed owner release; stall reported once per revision; deferred dedupe; notice batching.
- state fold: records order, invalid records counted, inherited control records ignored.
- integration (real Cordis composition, see packaging-findings Q6b): TeamService + our plugin with a mock LLM; Lead creates two teammates and tasks, a human `/dispatch on` arms, assert reassign + delivered brief + Lead notice; restart-free.
- command: role check, on/off/wip/status.
- tools: lead check, item merge, deadline normalization, schema stability snapshot.
- plugin apply/dispose: listeners and registrations removed on dispose (fake ctx).
