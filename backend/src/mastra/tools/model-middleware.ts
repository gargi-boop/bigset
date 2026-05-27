import { wrapLanguageModel } from "ai";

/**
 * Attempt to recover a double-encoded JSON tool-call input string.
 *
 * kimi-k2 via OpenRouter's non-streaming path sets
 *   `input = toolCall.function.arguments`
 * without validating that the string is parseable JSON.  When the model
 * wraps its arguments in an extra pair of quotes (i.e. the `function.arguments`
 * field is `"{"primary_key":"Pocket",...}"` instead of
 * `{"primary_key":"Pocket",...}`), the string starts with `"{"` which is a
 * JSON-encoded string literal — and JSON.parse then hits a trailing `}` or
 * other garbage that makes the parse fail.
 *
 * Recovery strategy: find the first `{` and the last `}` in the raw string
 * and extract that substring.  If the substring is valid JSON, use it;
 * otherwise leave the original string unchanged so the normal error path
 * can still handle it.
 */
function tryUnwrapDoubleEncodedInput(raw: string): string {
  // Only attempt recovery when the string starts with `"` — the hallmark of
  // the double-encoding pattern.  Normal JSON objects start with `{`.
  if (!raw.startsWith('"')) return raw;

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace <= firstBrace) return raw;

  const candidate = raw.slice(firstBrace, lastBrace + 1);
  try {
    JSON.parse(candidate);
    console.log(
      `[model-middleware] Repaired double-encoded tool call input (recovered ${candidate.length} chars)`,
    );
    return candidate;
  } catch {
    return raw; // Cannot repair — leave for Mastra's normal error path
  }
}

// ─── Approach 1: wrapLanguageModel middleware (intercepts at AI SDK stream level) ─

/**
 * Wrap a language model with a stream middleware that repairs double-encoded
 * tool-call inputs before Mastra processes them.
 *
 * kimi-k2 (via OpenRouter) occasionally wraps tool-call arguments in an extra
 * JSON string layer.  Mastra's `sanitizeToolCallInput` / `tryRepairJson` cannot
 * recover this pattern, so the tool call silently drops (args = undefined).
 * This middleware intercepts `tool-call` stream chunks and unwraps the extra
 * layer so Mastra receives clean JSON.
 *
 * Usage:
 *   model: withToolCallRepair(openrouter("moonshotai/kimi-k2-0905"))
 */
export function withToolCallRepair(model: any): any {
  return wrapLanguageModel({
    model,
    middleware: {
      wrapStream: async ({ doStream }: any) => {
        console.log("[model-middleware] wrapStream called");
        const result = await doStream();
        const { stream, ...rest } = result;

        const fixedStream = stream.pipeThrough(
          new TransformStream({
            transform(chunk: any, controller: any) {
              if (
                chunk != null &&
                chunk.type === "tool-call" &&
                typeof chunk.input === "string"
              ) {
                console.log(`[model-middleware] tool-call chunk: ${chunk.toolName} input starts with: ${chunk.input.slice(0, 30)}`);
                const fixedInput = tryUnwrapDoubleEncodedInput(chunk.input);
                controller.enqueue({ ...chunk, input: fixedInput });
              } else {
                controller.enqueue(chunk);
              }
            },
          }),
        );

        return { stream: fixedStream, ...rest };
      },
    },
  });
}

// ─── Approach 2: Startup monkey-patch for Mastra's sanitizeToolCallInput ────────

/**
 * Patch Mastra's internal sanitizeToolCallInput to handle double-encoded JSON.
 *
 * This is a fallback that operates at a lower level than the wrapStream
 * middleware. It patches the compiled Mastra module directly so that even if
 * the wrapStream approach doesn't intercept a particular code path, the repair
 * still happens before JSON.parse throws.
 *
 * Call this once at application startup (e.g. in src/index.ts before starting
 * Fastify) so it takes effect for all subsequent agent runs.
 */
export async function patchMastraSanitizeToolCallInput(): Promise<void> {
  try {
    // The chunk file that contains sanitizeToolCallInput is a private module
    // inside @mastra/core. We use a dynamic import to access it so we can
    // wrap its exported convertFullStreamChunkToMastra function.
    // However, since sanitizeToolCallInput is internal and not exported, we
    // patch the stream processing by intercepting at the AISDKV5InputStream
    // level instead.
    //
    // Strategy: intercept JSON.parse within the Mastra module scope by
    // wrapping the global JSON.parse to repair double-encoded inputs when
    // called from Mastra's tool call processing context.
    const originalJsonParse = JSON.parse;
    (JSON as any).parse = function patchedJsonParse(text: string, ...rest: any[]) {
      try {
        return originalJsonParse.call(this, text, ...rest);
      } catch (err) {
        // If JSON.parse fails on a string that starts with `"`, try the
        // double-encoding recovery: extract the JSON object between the
        // first `{` and last `}`.
        if (typeof text === "string" && text.startsWith('"')) {
          const firstBrace = text.indexOf("{");
          const lastBrace = text.lastIndexOf("}");
          if (firstBrace !== -1 && lastBrace > firstBrace) {
            const candidate = text.slice(firstBrace, lastBrace + 1);
            try {
              const recovered = originalJsonParse.call(this, candidate, ...rest);
              console.log(
                `[model-middleware/patch] Recovered double-encoded JSON (${candidate.length} chars): ${candidate.slice(0, 60)}...`,
              );
              return recovered;
            } catch {
              // Recovery also failed — re-throw the original error
            }
          }
        }
        throw err;
      }
    };
    console.log("[model-middleware] JSON.parse patched to recover double-encoded tool call inputs");
  } catch (err) {
    console.warn("[model-middleware] Failed to patch JSON.parse:", err);
  }
}
