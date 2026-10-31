// Typecheck-only shim for a packaging gap in @deepseek-ai/dsh-subagent@0.2.1-rc.5:
// lib/types/projection-types.d.ts adds `subagent` / `subagentTiming` to SessionProjectionMap,
// but lib/types/projection.d.ts (which adds the matching SessionProjectionStateMap keys) is not
// reachable from any exported entry point. Without it, @deepseek-ai/dsh-session-projection's
// d.ts fails under skipLibCheck: false (TS2536/TS2344). Pull the real declaration file in.
/// <reference path="../node_modules/@deepseek-ai/dsh-subagent/lib/types/projection.d.ts" />
// The scheduler does not import @deepseek-ai/dsh-subagent itself, but the agent-team d.ts reaches
// projection-types.d.ts (SessionProjectionMap `subagentCatalog`) without catalog.d.ts (its state key).
/// <reference path="../node_modules/@deepseek-ai/dsh-subagent/lib/types/catalog.d.ts" />
