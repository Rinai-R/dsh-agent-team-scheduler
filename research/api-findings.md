# DSH 0.2.1-rc.5 API findings for agent-team scheduler + fork-from-teammate

Evidence paths are abbreviated:
- `AT` = `/tmp/dsh-research/pkgs/deepseek-ai-dsh-experimental-agent-team-0.2.1-rc.5/lib`
- `TAT` = `/tmp/dsh-research/pkgs/deepseek-ai-dsh-experimental-tool-agent-team-0.2.1-rc.5/lib`
- `AG` = `.../deepseek-ai-dsh-agent-0.2.1-rc.5/lib`, `SE` = `.../deepseek-ai-dsh-session-0.2.1-rc.5/lib`
- `SUB` = `.../deepseek-ai-dsh-subagent-0.2.1-rc.5/lib`, `FORK` = `.../deepseek-ai-dsh-subagent-fork-in-process-0.2.1-rc.5/lib`
- other packages are named in full.

Everything is from the rc.5 d.ts/js unless marked **UNVERIFIED**.

---

## Q1. TeamService (`ctx.agentTeams`)

**Answer**

The public surface (`AT/types/index.d.ts:18-111`) takes the exact live `Agent` as the caller credential on every method:

```ts
class TeamService extends Service {
  static inject: string[]; // ['agents','sessions','sessionPersistence','sessionProjections','subagents'] (AT/index.js:1431-1437)
  membership(agent: Agent): TeamMembership;              // throws TEAM_NOT_MEMBER
  tryMembership(agent: Agent): TeamMembership | undefined;
  listMembers(agent: Agent): TeamMemberView[];
  spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult>;
  sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult>;
  createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView>;
  getTask(caller: Agent, id: TeamTaskId): TeamTaskView;
  listTasks(caller: Agent): TeamTaskView[];
  updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView>;
  waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>;
  interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'inactive' };
}
interface TeamMembership { root: Agent; id: TeamId; role: 'lead'|'teammate'; name: string } // AT/types/roster.d.ts:11-16
interface SpawnTeammateRequest { name; description; prompt: ContentBlock[]; context: 'fresh'|'fork'; provider: string; signal: AbortSignal } // types.d.ts:138-145
interface SendTeamMessageRequest { target: string; content: ContentBlock[]; signal: AbortSignal }     // :151-155
interface UpdateTeamTaskRequest { taskId; expectedRevision: number; action: TeamTaskAction; subject?; description?; blockedBy?; writeScopes?; owner?: string } // :170-179
type TeamTaskAction = 'claim'|'release'|'edit'|'set_dependencies'|'complete'|'reopen'|'reassign'|'delete'; // :168
interface TeamTaskView { id; revision; subject; description; status; blockedBy; writeScopes; ownerName?; ready: boolean; writeScopeWarnings: string[] } // :68-79
interface TeamMemberView { id: SessionId; name; role; status: 'running'|'inactive'|'provisioning'|'failed'; description?; provider?; context?; model?; diagnostics: string[] } // :43-53
```

**`reassign` on a `pending` task sets the owner and also moves the task to `in_progress`.** See `AT/index.js:1338-1355`:

```js
case "reassign": {
  if (!lead) throw new TeamError("only the Team Lead can reassign tasks", "TEAM_LEAD_REQUIRED");
  if (current.status !== "pending" && current.status !== "in_progress") throw ... "TEAM_TASK_INVALID_TRANSITION";
  if (request.owner === void 0 || request.owner.trim().length === 0) { next = withoutOwner({...current, status: "pending"}); break; }   // unassign => pending
  if (!taskReady(state, current)) throw ... "TEAM_TASK_BLOCKED";
  const assignee = resolveActiveMember(root, state, request.owner);   // must be phase 'active' or "lead"
  next = { ...current, status: "in_progress", ownerId: assignee.id };
```

**Action matrix** (`AT/index.js:1272-1381`). Every action runs inside a per-Lead serialized transaction, checks CAS on `expectedRevision`, rejects `deleted` tasks, and bumps `revision` by 1.

| action | who | allowed from | result |
|---|---|---|---|
| claim | any member (caller becomes owner) | pending + ready, unowned or owned by caller | in_progress, owner = caller |
| release | owner or Lead | in_progress | pending, owner cleared |
| edit | owner or Lead | any non-deleted | subject/description/writeScopes |
| set_dependencies | owner or Lead | any non-deleted | blockedBy (graph-validated) |
| complete | owner or Lead | in_progress | completed |
| reopen | owner or Lead | completed | pending, owner cleared |
| reassign | Lead only | pending or in_progress | with owner (task must be ready): in_progress + owner; without owner: pending + owner cleared |
| delete | owner or Lead | any non-deleted with no live dependents | deleted |

Notes:
- The Lead can also claim. `owner: "lead"` resolves to the Lead (`resolveActiveMember`, `AT/index.js:824-836`).
- A failed member's id can stay as `ownerId`. To release such a task the Lead uses `reassign` without an owner, or `release` (in_progress only).
- `projectTaskView` computes `writeScopeWarnings` only against **in_progress** tasks (`AT/index.js:366-385`). `scopesOverlap(a, b)` is equality or a path-prefix match (`:345-347`); it is not exported.
- `ready` = `status === 'pending'` and every blocker is `completed` (`:354-356`, `:382`).

**Change notification.** There is no public event, listener, or observable. `TeamActivity` is a private set of one-shot waiters (`AT/index.js:37-106`). It is notified only from:
1. `TeamJournal.appendAndFlush` → `onCommit(root)`, after every committed `team/*` append and flush (`:156-160`, wired at `:1461-1463`);
2. `ctx.on("agent/status", ({agent}) => ...)` for any agent with Team membership (`:1469-1472`);
3. `sendAdmitted`, after each peer message (`:1612`).

`waitForChange(caller, ...)` needs a live member Agent. The timeout must be 10 000–3 600 000 ms, and each call wakes once.

A host plugin can listen to the same underlying signals directly:
- `ctx.on('agent/status', ({agent, status}) => ...)`: a Cordis event declared in `AG/types/runtime-types.d.ts:252-255`.
- `ctx.on('session/event', (session, event) => ...)`: a post-commit append feed (`SE/types/index.d.ts:52-61`). Filter on `session.id === leadId` and `event.type === 'team/task' | 'team/member'`. This is better than polling `waitForChange` because it carries the committed snapshot.
- `ctx.on('agent/created' | 'agent/disposed', ({agent}) => ...)` (`runtime-types.d.ts:227-242`).

The roster uses its own `ctx.on('session/event')` subscription the same way (`AT/index.js:1087`).

**Reading state without a caller round-trip:**
- `ctx.sessionProjections.stateOf(leadAgent.session, 'agentTeam')` returns the full internal state `{ id, members: TeamMemberSnapshot[], tasks: TeamTaskSnapshot[] (incl. deleted), messages, delivered, nextTaskNumber, failure? }` (`AT/index.js:128-133`, schema `:519-527`).
- `listTasks(lead)` returns the views.

**Implication for our plugin**
- The scheduler can call `ctx.agentTeams.updateTask(leadAgent, { action: 'reassign', owner, taskId, expectedRevision })`. One call both assigns and starts the task (in_progress). The scheduler must then `sendMessage(leadAgent, { target: owner, ... })`, because a task assignment does not wake the teammate.
- `in_progress` is the scheduler's WIP set. Compute scope overlap ourselves by copying `scopesOverlap`, and check candidates against all in_progress tasks plus tasks assigned earlier in the same tick.
- Drive the scheduler from `session/event` (`team/task`, `team/member`) plus `agent/status`, with debounce. CAS failures (`TEAM_TASK_STALE_REVISION`) are normal races; re-read and retry next tick.
- Messages sent with the Lead as caller show the sender as `lead`, and they also wake the Lead's own waiters.

---

## Q2. Getting the live `Agent` for a SessionId; detecting the Lead

**Answer**

`ctx.agents` (`AgentRegistry`, `AG/types/index.d.ts:198-377`) provides:

```ts
get(id: SessionId): Agent | undefined;   // :343
list(): Agent[];                          // :357  live agents in registration order
roots(): Agent[];                         // :364  runtime top-level agents (no owning parent agent)
isOwnedBy(id: SessionId, owner: Agent): boolean; // :352
currentInitiator(): Agent | undefined;    // :218  the Agent driving the current async chain (works inside tool execute / command handlers)
```

The runtime `Agent` (`AG/types/runtime-types.d.ts:138-210`) has `id, options, session: Session, inbox: Inbox, status: 'idle'|'running', ctx`, plus `cancel, whenIdle, runMaintenance, send(msg, target, wakeup), followup(msg), steer(msg), inject(msg)`.

Lifecycle events (Cordis, `runtime-types.d.ts:212-408`):

| event | mode | payload |
|---|---|---|
| `'agent/created'` | serial; awaited before creation resolves, so do not await `whenIdle` inside | `{agent, source: 'startup'\|'resume'\|'clear'\|'compact', signal?}` |
| `'agent/disposed'` | emit | `{agent}` |
| `'agent/status'` | emit | `{agent, status}` |
| `'agent/turn-stopping'` | serial | `{agent, turn, signal}` |
| `'agent/error'` | emit | — |
| `'agent/inbox/inserted' \| 'claimed' \| 'discarded'` | emit | — |

There are no explicit "turn start/end" Agent events. Use `agent/status` (running/idle), or the `turn/start` and `turn/end` session events through `session/event`.

How agent-team finds live agents:
- `tool-agent-team.apply` iterates `ctx.agents.list()` at load, then installs on `agent/created` and removes on `agent/disposed` (`TAT/index.js:538-549`).
- TeamService schedules recovery the same way (`AT/index.js:1466-1468`, `:1483`).

Lead detection: `ctx.agentTeams.tryMembership(agent)?.role === 'lead'`. Implementation in `AT/index.js:870-903`:
- The Agent must be the exact registry entry (`ctx.agents.get(agent.id) === agent`).
- If `session.header.parentSession` names a live root whose `agentTeam` projection lists this agent, the role is `teammate`.
- Otherwise, any agent that is **not a provider-owned subagent child** (no subagent descriptor in its own events) is a `lead`.

**Caveat:** every top-level session, including ones that never spawned a teammate, counts as a "lead". To mean "a Team actually exists", additionally check `stateOf(agent.session,'agentTeam').members.length > 0`.

**Implication for our plugin**
- The scheduler keys its per-team state on the Lead SessionId.
- Resolve the Lead with `ctx.agents.get(leadId)` on every tick, never a cached object. After `clear` or `compact` the Agent object is replaced (`source: 'clear'|'compact'`) under the same id.
- If the Lead is not live (cold), the scheduler must stay idle. Every TeamService method needs a live Lead.
- Teammate liveness: `ctx.agents.get(member.id)?.status`. Prefer `listMembers(lead)`, which already maps this to running/inactive/provisioning/failed.

---
## Q8. Subagent provider API; cold resume

**Answer** — `SUB/types/types.d.ts:296-342`, `:115-121`, `:187-213`; registry `SUB/types/index.d.ts:288-298`:
```ts
interface SubagentProvider {
  readonly name: string;
  readonly capabilities: SubagentCapabilities;   // { agentOptions; agentPreset; outputSchema; depthLimit: boolean }
  readonly inheritsParentContext: boolean;        // descriptive only (tool wording), not validated
  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>;
  start?(request: ResolvedSubagentStartRequest): Promise<SubagentRun>;          // external execution
  prepareContinuable?(request: ContinuableCreateRequest): Promise<ContinuableCreateSpec>; // presence => local continuable
}
interface ContinuableCreateRequest { readonly cwd: string; readonly sessionId: SessionId; readonly parent: Agent; readonly signal: AbortSignal } // NOTE rc.5 adds cwd
interface ContinuableCreateSpec { readonly seed?: readonly SessionEvent[] }  // "contiguous from seq 0, lossless JSON, balanced"
// ctx.subagents:
registerProvider(provider: SubagentProvider): () => void;   // effect-scoped, HMR safe; rejects providers lacking start+prepareContinuable
getProvider(name: string): SubagentProvider | undefined;  list(): string[];
```
Reference impl `FORK/index.js:22-52`: `capabilities = {agentOptions:true, agentPreset:false, outputSchema:true, depthLimit:true}`, `inheritsParentContext = true`, `prepareContinuable` returns `{seed}` = `parent.session.snapshotEvents()` sliced through the last `turn/end` (or `{}` if none). `inject = ['subagents']`, `Config = z.object({providerName: z.string().default('fork')})`.

Creation flow (`SUB/index.js:1395-1450`): `startActivation` → `expectProvider(spec.provider)` (`:3037`) and `assertCapabilities`, requires `ctx.agents.get(parent.id) === parent` (`:3044`) → `startLocal` calls `host.prepareContinuable(spec.provider, { sessionId: childId, cwd, parent, signal })` (`:1416-1421`), then `inheritedEventCount = seed.length`, header meta from `childSessionMeta(parent, …, isSeeded = seed !== undefined)` → `parentSession: parent.session.header.id` (i.e. the **Lead**, regardless of seed origin; `:346-356`). Child setup appends `subagent/descriptor {mode:'continuable', provider: spec.provider, label, agentProvider/Model…}` (`:1404-1411`, `:1799`).

**Cold resume does NOT look the provider up.** `coldResume` (`SUB/index.js:2141-2195`) reads the child via `ctx.sessionQuery.observeSession(childId)`, folds `subagent/descriptor` from own events, checks `mode === 'continuable'`, and calls `materialize({ kind:'local', provider: descriptor.provider, … })` with no `create` → `ctx.agents.resume(...)` (`:1806-1811`). `materializeTracked` only carries `provider` as data (`:1765`); `expectProvider` is called only from `startActivation`/`start` (`:2998`, `:3037`). Team recovery also only compares `descriptor.provider === member.provider` as strings (`AT/index.js:1124`). ⇒ Our provider must be registered only for *creation*; resume of an existing forked teammate works even if our plugin is unloaded (VERIFIED by code reading; not runtime-tested).

**Implication for our plugin**
- Implement `{ name:'fork-from', capabilities:{agentOptions:true, agentPreset:false, outputSchema:true, depthLimit:true}, inheritsParentContext:true, prepareContinuable }`. `request.parent` is the Lead; look up the handoff keyed by `request.parent.id` (and optionally `request.sessionId` is unknown to the tool beforehand — TeamService mints the child id internally with `randomUUID()` (`AT/index.js:1012`), so key by Lead id + serialize per Lead).
- If no handoff is present, fall back to Lead completed-turn prefix or `{}` (fresh) — must never throw silently into a wrong context; better throw `Error('no fork source staged')` so `spawnTeammate` records the member `failed`.
- `team/member.provider` will durably store our provider name; `context:'fork'`.

---

## Q9. Reading another session's full `SessionEvent[]` (live and cold); seed validity

**Answer**
- **Live**: `ctx.agents.get(id)?.session.snapshotEvents(from?, toExclusive?)` (`SE/types/index.d.ts:224`) — still works in rc.5 and is what the fork provider and agent-team use, but is marked `@deprecated … new calls are prohibited` (in-repo lint policy; no runtime effect). Also `ctx.sessions.get(id)` returns the live `Session`.
- **Live-or-cold, recommended**: `ctx.sessionQuery` (`dsh-session-query/lib/types/index.d.ts:25,42-47,69-75`):
  ```ts
  observeSession(sessionId: SessionId, options?: { signal?: AbortSignal; projectionMode?: 'all'|'none' }): Promise<SessionObservation>; // Disposable lease; live-preferred
  interface SessionObservation extends Disposable { source:'live'|'prepared'; header: SessionHeader; inheritedEventCount; events: readonly SessionEvent[]; cursor; projections?; retain() } // observation.d.ts:7-31
  readSession(sessionId: SessionId): Promise<{ session: SessionHeader; inheritedEventCount; events: SessionEvent[] }>; // "after in-memory interrupted-turn balancing and replay validation" (types.d.ts:33-41)
  ```
  This is exactly what subagent cold-resume uses (`SUB/index.js:2148-2151`, with `using`/dispose). Cold path opens a persistence **read** preparation, no writer lock.
- **Cold, low level**: `ctx.sessionPersistence.open(id, 'read', { signal })` → `handle.read(0, undefined, { signal })` → `{ events }`, `handle.header`, `handle.inheritedEventCount`, then `handle.close()` (agent-team `readPersistedSession`, `AT/index.js:749-761`). Read handle = no writer lock.
- Seed contract (`AG/types/index.d.ts:75-80`, `SUB/types/types.d.ts:206-213`): contiguous from seq 0, lossless JSON, balanced (no open turn/step). The fork provider's "slice through last `turn/end`" satisfies this because live seq == array index (`FORK/index.js:15-27`). `SE/index.js:1129` validates each seed envelope (`type`, safe-int `seq`, `time`, `data`, `ignorable` only `true`). The Session constructor appends the child's tagged `session/end-seed {inherited:true}` marker at the cut (`SE/types/types.d.ts:405-433`).
- **Nested fork (seed from a teammate whose log itself began with a fork seed)**: supported by the format — "A fresh fork child owns one `{ inherited: true }` marker at its exact inherited-prefix cut, even when that prefix ends in an ancestor marker … The last tagged marker is the current Session's cut" (`SE/types/types.d.ts:409-418`). The teammate's own `subagent/descriptor` lands inside our child's inherited prefix; descriptor folding uses only own events (`events.slice(inheritedEventCount)` in `SUB/index.js:2158`, `AT/index.js:1121-1122,1184`), so the child is still classified by *its own* descriptor → Team membership resolution remains correct. VALID (by code reading).

Risks (UNVERIFIED, test these):
1. The teammate prefix contains `agent/inbox/spliced` events; any inbox items inserted before the last `turn/end` and not yet claimed would replay as pending inbox in the child (the `inbox` projection folds splices). Same risk exists for the official fork provider; mitigate by cutting at a `turn/end` after which the inbox fold is empty, or by checking `pendingInboxMessages`-style fold on the slice.
2. Prefix also carries the teammate's delegated-policy / working-directory / `agent-preset/selected` events; the child additionally appends its own after the seed (`SUB/index.js:1797-1803`), and later events win in folds — believed benign.
3. Cold `readSession` adds synthetic balancing closers for an interrupted tail; still slice through the last *real* `turn/end` you choose. If the teammate is mid-turn (running), the last completed `turn/end` is the cut.
4. Header `parentSession` = Lead, not the source teammate; lineage to the source is not recorded anywhere unless we write our own plugin record.

**Implication for our plugin**: in `prepareContinuable`, resolve source: if `ctx.agents.get(srcId)` live → `snapshotEvents()`; else `using obs = await ctx.sessionQuery.observeSession(srcId, {signal, projectionMode:'none'})` → `obs.events`. Slice `[0..lastTurnEnd.seq]`, `structuredClone` not needed (Session snapshots seed). Require source `header.parentSession === lead.id` (same Team) and source is an active/known roster member. `inject: ['subagents', 'agents', 'sessionQuery']` (sessionQuery optional via `ctx.get('sessionQuery')` if we only need live).

---
## Q4. Registering model tools visible to all Team members

**Answer** — `ctx.tools.register(definition: ToolDefinition): () => void` — "Register globally or in the calling agent scope. Scoped tools shadow globals" (`dsh-tools/lib/types/index.d.ts:631-637`). Build definitions with `defineTool` (`schema.d.ts:248`):
```ts
defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S,O>): ToolDefinition;
// DefineToolOptions: { name; description; parameters: S; output: { schema: O; render(args, value): ContentBlock[]; presentationMeta? };
//   deferLoading?; timeoutMs?; isConcurrencySafe?(args); execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<O>>;
//   projectContent?; finalizeContent?; presentCall?; presentResult? }   (schema.d.ts:185-247)
// ToolRunContext: { …, readonly agent?: Agent /* set by agent loop */, readonly signal: AbortSignal }   (index.d.ts:~255-270)
```
`parameters` use a schemastery-like JSON spec: `{ name: { type:'string', required:true, description }, context: { type:'string', enum:[…] }, items:{type:'string'} }` (`TAT/index.js:253-274`). Output is a canonical JSON value validated against `output.schema`; `render` turns it into model content (tool-agent-team uses `jsonOutput(schema)` → `[{type:'text', text: JSON.stringify(value)}]`, `TAT/index.js:211-219`). Errors: just `throw` (TeamError messages become tool errors).

How tool-agent-team does it (`TAT/index.js:227-554`):
- `inject = ['agents','agentTeams','tools','systemPrompt']`.
- `apply`: for every `ctx.agents.list()` and on `'agent/created'`, if `ctx.agentTeams.tryMembership(agent) !== undefined` → `install(agent)`; on `'agent/disposed'` dispose; `ctx.effect(() => () => disposeAll)` (`:531-554`).
- `install` registers via the **agent scope**: `agent.ctx.tools.register(defineTool({...}))`, plus `agent.ctx.systemPrompt.section({name, order: getSectionOrder('TEAM_POLICY'), text})` and `.context({ name:'team:identity', order: getContextOrder('TEAM_IDENTITY'), required:true, text: () => … })` (`:227-249`).
- **Identical schema for Lead and teammates**: the same 9 tools (incl. Lead-only `spawn_teammate`, `interrupt_agent`) are installed for *every* member; the role is enforced at execute time inside TeamService (`TEAM_LEAD_REQUIRED`), not by hiding the tool. Calling agent: `exec.agent` (`callingAgent()` throws if undefined, `:221-225`).
- Note `tryMembership` treats every non-subagent root as `lead`, so these tools are installed on any top-level session.

**Implication for our plugin**: register `spawn_teammate_from` the same way (agent-scoped, on every Team member, identical schema, Lead check at execute via `ctx.agentTeams.membership(exec.agent).role === 'lead'`, else throw). Keeping teammates' tool lists identical matters because fork seeds copy history whose `developer/message` tool-addition blocks reference tool names (`SE/index.js:249-259`). Mid-session scoped registration emits `tools/change` and the loop logs tool additions; install early (on `agent/created`). Our plugin must load **after** agent-team (inject `agentTeams`).

---

## Q5. Human slash command (no model turn)

**Answer** — `ctx.commands` from `@deepseek-ai/dsh-commands` (fetched to `/tmp/dsh-research/pkgs/deepseek-ai-dsh-commands-0.2.1-rc.5`). `/goal` = `ctx.commands.register({...})` with `inject = ['commands','goals']` (`dsh-command-goal/lib/index.js:10,174-185`):
```ts
register(definition: CommandDefinition): () => void;   // dsh-commands/lib/types/index.d.ts:94 (effect-scoped)
interface CommandDefinition { definitionId?: CommandDefinitionId; name: string /* lowercase, no slash */; description: string;
  input?: { hint: string; attachments?: boolean }; recordInput?: boolean;
  handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult> }          // index.d.ts:38-55
interface CommandInvocation { commandId; agent: Agent /* exact agent whose UI received the command */; rawInput: string; attachments; signal: AbortSignal } // :19-36
type CommandResult = { kind:'success'; text?: string; sourceEventSeq?: SessionSeq } | { kind:'error'; text: string };  // types.d.ts:32-41
// CommandDefinitionId from '@deepseek-ai/dsh-commands/brand' (brand.d.ts:13,19)
```
"Parse and execute a known command without sending it to the model … `command/run` before the handler … `command/done` after settlement … direct log-only appends — no turn wraps them" (`index.d.ts:115-150`). The target is `invocation.agent` (the Session whose UI typed it). `/goal` itself is model-silent; only optional attachments are pushed with `agent.followup(...)` (`command-goal/index.js:98-107`).

**Implication for our plugin**: `/team-dispatch [on|off|status|wip <n>]` handler: `const lead = invocation.agent; if (ctx.agentTeams.tryMembership(lead)?.role !== 'lead') return {kind:'error', …}` then arm/pause scheduler state keyed by `lead.id`, persist via plugin record (Q7). Because model tools never receive this capability, arming is human-only. Add `'commands'` to `inject`.

---
## Q6. Delivering a durable notice to the Lead's model context

**Answer** — all paths go through the Agent inbox (`AG/types/runtime-types.d.ts:176-209`). Every inbox mutation is durably logged as `agent/inbox/spliced` (`AG/types/types.d.ts:79-93`), and a claimed message becomes a model-visible `user/message`. Build the message with `createUserMessage({ content: ContentBlock[], source })` from `@deepseek-ai/dsh-llm`. `source.kind` must be a non-empty string (`SE/index.js:1205`); declare it by merging into `MessageSourceMap` in `@deepseek-ai/dsh-llm`, as agent-team does (`AT/types/types.d.ts:121-125`).

| API | Starts a turn? | Semantics |
|---|---|---|
| `agent.inject(msg)` | **No** | "Queue model-facing context for the next pre-step without waking the driver. A running driver claims it at the nearest later step boundary; idle drivers leave it pending until follow-up or steering wakes them. It may miss a request whose pre-step already claimed its batch. Cancellation or disposal may discard pending context." (`:202-209`) |
| `agent.steer(msg)` | Yes if idle; otherwise consumed at the next step | (`:193-200`); used by `TeamService.sendMessage` to the Lead (`AT/index.js:1604-1610`) |
| `agent.followup(msg)` | Yes; a separate turn of its own | (`:187-192`); used by goal rounds (`goal-round-driver/index.js:144-164`) |
| `agent.send(msg, 'next-turn'\|'next-step', wakeup: boolean)` | Only if `wakeup` | (`:175-186`) |
| `ctx.agentTeams.sendMessage(teammate, {target:'lead', …})` | Yes (steer) | Needs a **teammate** caller. A Lead caller cannot message itself (`TEAM_SELF_MESSAGE`, `AT/index.js:1592`). |

Existing official patterns:
- **Subagent settlement**: `parent.inject(msg)` while the parent is closing, else steer if running or a follow-up queue if idle (`SUB/index.js:2049-2058`, `:1631-1642`). Source `{kind:'subagent-settled', form:'notice', summary, senderSessionId}` (`SUB/types/continuation-messages.d.ts:26-39`).
- **Tool-jobs completion**: `owner.followup(msg)` while the owner is idle and within the wake budget, else `owner.inject(msg)` (`dsh-tool-jobs/lib/index.js:271-295`). Source `{kind:'tool-jobs', form:'notice', summary}`.
- **Goal**: durable state goes in `goal/change`, and model input goes through `followup` with `source:{kind:'goal', …}`.

A purely log-only, non-model-visible record is also possible through `appendPluginRecord` (Q7). It is not a notice to the model.

**Implication for our plugin**
- Scheduler decisions go to the Lead with `lead.inject(createUserMessage({ content:[{type:'text', text:'[dispatch] assigned task-3 → api-scout …'}], source:{ kind:'team-dispatch', form:'notice', summary } }))`. This does not start a turn and is durable once spliced. If the Lead is idle, the notice waits until its next wake.
- When an important event should wake the Lead, for example all tasks done or a member failed, use `steer` or `followup` instead.
- `form:'notice'` with a `summary` matches how existing sources collapse in the UI. **UNVERIFIED** whether the web client renders unknown `kind` values gracefully; it is likely shown as generic user content.

---

## Q3. Observing durable events appended to the Lead Session

**Answer**
1. `ctx.on('session/event', (session: Session, event: SessionEvent) => void)` is a "post-commit, fire-and-forget append feed". Its callbacks run after the log push, and failures are contained (`SE/types/index.d.ts:52-61`). Seed and replay events never publish (`index.d.ts:157`). Listen from the root context to see all sessions. Agent-scoped listeners see only that agent's sessions. Filter with `event.type === 'team/task' || 'team/member'` and `session.id === leadId`, or with `ctx.agentTeams.tryMembership(ctx.agents.get(session.id))?.role === 'lead'`.
2. `ctx.sessionProjections.onChanged((session, key, value, seq) => …)` fires when a client-visible projection's view changes by `Object.is` (`dsh-session-projection/lib/types/index.d.ts:161-167`). For `key === 'agentTeam'`, the view changes only when the members or tasks arrays change; mailbox-only changes reuse the reference (`AT/index.js:705-725`). It delivers the whole `TeamProjection {members, tasks: TeamTaskView[], failure?}`, which is ideal as the scheduler trigger.
3. `ctx.on('session/created' | 'session/disposed', session => …)` (`SE/types/index.d.ts:41-50`).

The events are committed before `appendAndFlush` awaits the flush, so the feed fires before the durable checkpoint completes.

**Implication for our plugin**: subscribe to `sessionProjections.onChanged` for `agentTeam`, plus `agent/status`, and run a debounced (microtask or ~100 ms) `tick(leadId)`. Do not mutate Team state synchronously inside the listener. Append reentry is forbidden ("append cannot reenter while another append is being published", `SE/index.js` publicationEntry), so always defer with `queueMicrotask` or `setTimeout`.

---

## Q7. Custom session events, log-only records, projections

**Answer**
- **Declaration merging**: `declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'x/y': {...} } }` (agent-team `AT/types/types.d.ts:184-211`; goal `dsh-goal/lib/types/domain.d.ts:46-50`). Then call `session.append('x/y', data)` (`SE/types/index.d.ts:277`). Non-surface types must not pass surface options.
- **Danger for out-of-repo plugins.** `Session.append` never sets `ignorable`. The persistence read path "refuses to interpret a log containing a type outside this set [`KNOWN_SESSION_EVENT_TYPES`] unless the event carries the envelope's `ignorable` marker … Downstream (out-of-repo) plugin events are outside this list by construction" (`SE/types/known-event-types.d.ts:7-21`). `team/*` and `goal/change` are in the list (`SE/index.js:79-126`). **A third-party `SessionEventMap` event appended with `append()` would make the Lead session un-resumable.** Do NOT do this.
- **Correct mechanism**: plugin records.
  ```ts
  import { appendPluginRecord, pluginRecordOf, type PluginRecordMap } from '@deepseek-ai/dsh-session';
  declare module '@deepseek-ai/dsh-session/types' { interface PluginRecordMap { 'plugin:dsh-agent-team-scheduler/state': {...} } }
  appendPluginRecord(session, 'plugin:dsh-agent-team-scheduler/state', data): SessionSeq;  // SE/types/index.d.ts:94-117
  pluginRecordOf(event): PluginRecord | undefined;  // { type, seq, time, data: unknown }  (:118-126)
  ```
  The type grammar is `/^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/` (`SE/index.js:1248`). A record is written with `ignorable: true` (`SE/index.js:1546-1560`), never enters the model surface, and is carried through fork and resume. Migrations retain records best-effort only. The "only `packages/experimental/`" restriction is an in-repo lint gate (`verify-plugin-record-callers`), not a runtime check. Validate `data` on read.
- **`ignorable` semantics** (`SE/types/types.d.ts:497-508`): a reader that does not recognize the type may skip the event when the flag is set. Without it, the reader MUST refuse to reconstruct.
- **Projection**: `ctx.sessionProjections.register(def)` (`dsh-session-projection/lib/types/index.d.ts:150-159`). `ProjectionDefinition` (`:38-80`) has `{ key; stateSchema: ZodType<S>; init(header, inheritedEventCount): S; apply(state, event): S /* same ref if uninterested */; wire?: { viewSchema; view(state) }; stateVersion: number }`. Declare the key in `SessionProjectionStateMap` (host-only) and/or `SessionProjectionMap` (client-visible) in `@deepseek-ai/dsh-session-projection/types`. Cells fold lazily over the in-memory log on first touch, so a projection replays restored events on load automatically. Agent-team registers its projection inside `ctx.effect(() => ctx.root.sessionProjections.register(def))` (`AT/index.js:1473-1482`).
- **Reading state**: `ctx.sessionProjections.stateOf(session, key)` (`:175`) returns live state that must not be mutated. Agent-team reads `stateOf(lead.session, 'agentTeam')` (`AT/index.js:128-133`).
- `stateSchema` is a **zod** schema (agent-team imports `zod`, `AT/index.js:6`), so we need `zod` as a dependency.

**Implication for our plugin**: persist "armed / paused / WIP limit" per Lead as `plugin:dsh-agent-team-scheduler/control` records. Fold them with a host-only projection `teamDispatch`, or simply scan with `pluginRecordOf` over `observeSession` on resume. Arming then survives restarts, and only the human command writes the record. For fork-from-teammate lineage, write `plugin:…/fork-source {childId, sourceId, cutSeq}` into the Lead log.

---
## Q10. Plugin module conventions (Config / inject / name / apply)

**Answer**
- **Function plugin module.** Export `name`, `inject`, `Config`, and `apply`.
  - Example 1: `export const name = 'tool-agent-team'; export const inject = ['agents','agentTeams','tools','systemPrompt']; export const Config = z.object({ interrupt: z.boolean().default(true), freshProvider: z.string().default('spawn'), forkProvider: z.string().default('fork') }); export function apply(ctx, config = {}) {...}` (`TAT/index.js:7-20,531`; d.ts `TAT/types/index.d.ts:5-20` types `Config` as an interface plus `export declare const Config: z<Config>`).
  - Example 2: the fork provider, `inject = ['subagents']`, `Config = z.object({ providerName: z.string().default('fork') })` (`FORK/index.js:11-13`).
- **Service class.** `class X extends Service { static inject = [...]; static Config = z.object({...}); constructor(ctx, config) { super(ctx, 'serviceName') } }`. TeamService uses `z.number().step(1).min(1).default(16)` (`AT/index.js:1430-1458`). It augments `Context` with `declare module '@deepseek-ai/cordis' { interface Context { agentTeams: TeamService } }` (`AT/types/index.d.ts:12-16`).
- **`inject` shape.** `type Inject = (keyof M)[] | { [K]?: config }` (`cordis/lib/types/registry.d.ts:13-15`). For optional services, use `ctx.get('name')` (for example `this.ctx.get("sessionPersistence")`, `SUB/index.js:1395`) or `ctx.inject(['svc'], (subCtx) => ...)`, which reloads when the service appears (`registry.d.ts:111,185`).
- **Lifecycle cleanup.** Use `ctx.effect(() => () => cleanup, 'label')` (`TAT/index.js:550-553`). Cordis disposes `ctx.on(...)` listeners and `register*` disposers with the plugin fiber.
- **Packaging.** Package as ESM (`"type":"module"`, `main: lib/index.js`, `types`). Pin `@deepseek-ai/dsh-*` to the exact `0.2.1-rc.5` and `@deepseek-ai/cordis` to `~4.0.5` as peers. `@deepseek-ai/schemastery` `~3.18.5` is a dependency (tool-agent-team `package.json`). **UNVERIFIED:** how dsh loads an out-of-repo plugin into a profile (plugin-manager or app-boot profile). Check `dsh-plugin-manager` / `dsh-app-boot` profile docs before packaging.

**Required `inject` for our plugins**
- Scheduler (host): `['agents', 'agentTeams', 'sessionProjections', 'commands']`, plus optional `sessions` (for flush) and `tools` (only if we add tools).
- Fork-from provider and tool: `['agents', 'agentTeams', 'subagents', 'tools', 'sessionQuery']`. `sessionQuery` is optional and needed only for cold sources; `subagents` coldResume already requires it, so it should be present in Team deployments.

---

## Blockers and workarounds

**Not blockers (verified feasible)**
- `reassign` on a pending task sets the owner and moves the task to `in_progress` in one Lead-authorized CAS call.
- Cold resume of forked teammates does not require our provider (Q8).
- A host plugin can do everything TeamService needs **only while the Lead Agent is live**.

**Real constraints, ranked**

1. **TeamService needs a live Lead `Agent` as credential, and there is no public change-notification API.**
   - Workaround: resolve `ctx.agents.get(leadId)` each tick. Trigger from `sessionProjections.onChanged` (key `agentTeam`), `session/event`, and `agent/status`. Pause automatically while the Lead is cold.
   - TeamService's internal `TeamActivity.notify` is private; do not rely on it.
2. **Messages sent by the scheduler are attributed to "lead".** `sendMessage(lead, …)` prefixes "Team message from lead:" and wakes the target. That is acceptable, but it also wakes the Lead's own waiters.
   - The scheduler cannot send a notice *to* the Lead through TeamService, because a Lead→Lead message is rejected with `TEAM_SELF_MESSAGE`.
   - Workaround: use `lead.inject(createUserMessage(...))` with our own `source.kind` (Q6). It does not wake the Lead.
3. **Custom durable state must not use `SessionEventMap` + `append()` (B/A persistence).** Unknown non-ignorable types make the Lead session refuse to load (Q7).
   - Workaround: use `appendPluginRecord` with `plugin:<pkg>/…`. It is officially "experimental only" by lint policy, but there is no runtime check. Risk: migrations retain records best-effort only.
4. **The provider request lacks the source teammate (B).** `ContinuableCreateRequest` = `{cwd, sessionId, parent, signal}`; `sessionId` is minted inside TeamService (`randomUUID`, `AT/index.js:1012`), so it is unknown to the tool beforehand.
   - Workaround: a per-Lead in-process handoff map keyed by `parent.id`. Serialize `spawn_teammate_from` per Lead with a mutex so two concurrent spawns cannot swap sources. Clear the entry in `finally`.
   - Upstream ask: pass an opaque `providerData` through `SpawnTeammateRequest` → `startActivation` → `prepareContinuable`.
5. **Lead detection is loose.** `tryMembership` returns `lead` for every non-subagent root session. The scheduler should require that a human armed it on that session, which the design does anyway.
6. **`snapshotEvents` is `@deprecated` (lint-only).** Prefer `ctx.sessionQuery.observeSession()` for both live and cold reads. It is live-preferred, disposable, and needs no writer lock.
7. **Seed hygiene (B, UNVERIFIED risks).**
   - A teammate prefix may contain pending inbox splices that would replay in the child.
   - The header `parentSession` is the Lead, so lineage to the source is lost.
   - Mitigation: cut at a `turn/end` where the inbox fold over the prefix is empty, and record the lineage in a plugin record.
   - Nested fork seeds are format-valid.
8. **Write-scope overlap is advisory and only computed against in_progress tasks.** `scopesOverlap` is not exported; copy its 1-line logic (`AT/index.js:345-347`) and normalize scopes the way `writeScope()` does (`:807-812`).
9. **A failed member keeps its tasks.** Nothing auto-releases them. The scheduler must `reassign` with no owner (pending + unowned) for tasks whose `ownerName` maps to a member with `status === 'failed'`.
   - `TeamTaskView.ownerName` is `undefined` when the owner id is not in the roster; use `stateOf(...).tasks[].ownerId` for exact ids.
