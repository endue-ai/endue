// Writing help: the brain shortens a draft to an account's limit or adapts it for a network
// (`brain.ask`, ADR 0059). It answers by calling the studio's own tool with the new text, which the
// studio shows beside the draft; the person keeps it or not. Nothing is published by it.

export const ASK = Object.freeze({ permission: "brain:ask" });
const WAIT_MS = 120_000;
const TOOL = {
  name: "social_text",
  description: "The rewritten post text, ready to publish as it is.",
  schema: {
    type: "object",
    properties: { text: { type: "string", maxLength: 10000 } },
    required: ["text"],
    additionalProperties: false,
  },
};

/**
 * @param {{ bridge: {
 *   call(method: string, params: Record<string, unknown>): Promise<any>,
 *   onEvent(listener: (event: any) => void): unknown,
 * } }} ctx
 */
export function createHelp(ctx) {
  /** @type {Map<string, { done(data: any): void }>} */
  const waiting = new Map();
  /** @type {Map<string, any>} */
  const early = new Map();
  ctx.bridge.onEvent((event) => {
    if (
      event.event !== "brain.turn" ||
      !["completed", "error", "offline"].includes(event.data?.kind)
    )
      return;
    const turn = waiting.get(event.data.turnId);
    if (turn) turn.done(event.data);
    else early.set(event.data.turnId, event.data);
  });

  /**
   * The text the brain wrote for `what`: `shorten` to `limit` characters, or `adapt` for `network`.
   * @param {{ what: "shorten" | "adapt", text: string, limit?: number, network: string, language: string }} job
   * @returns {Promise<string>}
   */
  async function ask(job) {
    const task =
      job.what === "shorten"
        ? `Shorten this social media post to at most ${job.limit} characters for ${job.network}, keeping its meaning, voice and any links or hashtags that matter.`
        : `Adapt this social media post for ${job.network}: its usual length, tone and hashtag habits, keeping what it says.`;
    const prompt = `${task} Write in the post's own language (the desk's language is ${job.language}). Answer only by calling ${TOOL.name} with the new text.\n\nThe post:\n${job.text.slice(0, 10000)}`;
    const { turnId } = await ctx.bridge.call("brain.ask", {
      prompt,
      tool: TOOL,
      scope: { ...ASK },
    });
    const data = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(turnId);
        reject(new Error("timeout"));
      }, WAIT_MS);
      const done = (/** @type {any} */ d) => {
        clearTimeout(timer);
        waiting.delete(turnId);
        resolve(d);
      };
      const first = early.get(turnId);
      early.delete(turnId);
      if (first) done(first);
      else waiting.set(turnId, { done });
    });
    const text = /** @type {any} */ (data).structured?.text;
    if (/** @type {any} */ (data).kind !== "completed" || typeof text !== "string")
      throw new Error(/** @type {any} */ (data).text || "no answer");
    return text;
  }
  return { ask };
}
