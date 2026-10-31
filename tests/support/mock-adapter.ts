/**
 * Scripted mock LLM adapter, adapted from the DeepSeek Harness monorepo
 * `packages/core/agent-loop/tests/mock-adapter.ts` (MIT). Instead of one shared queue it routes
 * every request through a `respond` callback, so concurrent Team members get deterministic
 * answers.
 */
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** Text-only answer that ends the turn. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One tool call that asks the loop to execute `name(args)`. */
export function toolCallResponse(rawCallId: string, name: string, args: object): StreamChunk[] {
  const callId = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Mock adapter whose every model call is answered by `respond`. Records requests. */
export class RoutingMockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  /** @param respond - computes the chunks for one request. */
  constructor(private readonly respond: (options: GenerateOptions) => StreamChunk[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.respond(options)
    for (const chunk of chunks) {
      if (options.signal?.aborted === true) throw new Error('aborted')
      yield await Promise.resolve(chunk)
    }
  }
}
