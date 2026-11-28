// studio.* for the shell's agent bar and its endue windows (ADR 0129): the person's endue agents,
// their conversations, facets and faces, and the spaces they can open, called as the runtime under
// studio:manage, and an agent's conversation in its window (ADR 0411). The core holds the token; only endue.ai's own https pages are opened.
import type { BridgeClient, ShellOpenPermission } from "@endue-ai/bridge";
import type { StudioShellBridge } from "@endue-ai/runtime";

const STUDIO = { scope: { permission: "studio:manage" } } as const;
const OPEN: ShellOpenPermission = { permission: "shell:open", schemes: ["https"] };
/** The conversations read for presence: the most recently active ones. */
const CONVERSATIONS = 50;
/** The messages read at a time in an agent's window. */
const MESSAGES = 30;
/** The only pages the shell opens: endue.ai's. */
const WEB = "https://endue.ai/";

export function studioShell(core: BridgeClient): StudioShellBridge {
  return {
    agents: async () => (await core.call("studio.agents.list", STUDIO)).agents,
    conversations: async () =>
      (await core.call("studio.conversations.list", { limit: CONVERSATIONS, ...STUDIO }))
        .conversations,
    facets: (agentId) => core.call("studio.agents.facets", { agentId, ...STUDIO }),
    picture: (agentId) => core.call("studio.agents.picture", { agentId, ...STUDIO }),
    spaces: async () => (await core.call("studio.spaces.list", STUDIO)).spaces,
    space: (spaceId) => core.call("studio.spaces.get", { spaceId, ...STUDIO }),
    ask: (question) => core.call("studio.chat.ask", { ...question, ...STUDIO }),
    thread: {
      messages: (conversationId, before) =>
        core.call("studio.messages.list", {
          conversationId,
          ...(before ? { before } : {}),
          limit: MESSAGES,
          ...STUDIO,
        }),
      send: (line) => core.call("studio.chat.send", { ...line, ...STUDIO }),
      async attach(conversationId, agentId) {
        await core.call("studio.chat.attach", { conversationId, agentId, ...STUDIO });
      },
      async stop(conversationId, runId) {
        await core.call("studio.chat.stop", { conversationId, runId, ...STUDIO });
      },
      read: async (conversationId) =>
        (await core.call("studio.conversations.read", { conversationId, ...STUDIO }))
          .previousReadAt,
      onEvent: (listener) =>
        core.onEvent((event) => {
          if (event.event === "studio.chat.event") listener(event.data);
        }),
    },
    async open(url) {
      if (!url.startsWith(WEB)) throw new Error(`only endue.ai's pages open here: ${url}`);
      await core.call("shell.open", { target: url, scope: OPEN });
    },
  };
}
