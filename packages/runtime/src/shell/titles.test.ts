import type { StudioAgent, StudioSpace } from "@endue-ai/bridge";
import { describe, expect, it } from "vitest";
import { emptyEndue } from "../system/endue-ids";
import { Store, sampleState } from "./state";
import { surfaceTitle, viewTitles } from "./titles";

const agent = { id: "ag_1", slug: "scout", name: "Scout", status: "active" } as StudioAgent;
const space = { id: "sp_1", key: "team", name: "Team room", status: "active" } as StudioSpace;
const tr = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}(${Object.values(vars).join(",")})` : key;

function store(endue = emptyEndue()) {
  return new Store({ ...sampleState("en", 0), endue });
}

describe("an endue window's title", () => {
  it("an_endue_agents_window_is_named_by_the_agent", () => {
    const s = store({ ...emptyEndue(), state: "ready", agents: [agent] });
    expect(surfaceTitle({ store: s, tr }, "endue-agent:ag_1")).toBe("Scout");
  });

  it("a_space_window_is_named_by_the_space", () => {
    const s = store({ ...emptyEndue(), state: "ready", spaces: [space] });
    expect(surfaceTitle({ store: s, tr }, "endue-space:sp_1")).toBe("Team room");
  });

  it("before_the_name_is_read_it_is_the_handle_then_endue", () => {
    const nameless = { ...agent, name: " " };
    const s = store({ ...emptyEndue(), state: "ready", agents: [nameless] });
    expect(surfaceTitle({ store: s, tr }, "endue-agent:ag_1")).toBe("@scout");
    // Signed out, nothing is known: never the id.
    expect(surfaceTitle({ store: store(), tr }, "endue-agent:ag_9")).toBe("endue");
    expect(surfaceTitle({ store: store(), tr }, "endue-space:sp_9")).toBe("endue");
  });

  it("view_titles_carry_the_name_to_the_window_manager", () => {
    const s = store({ ...emptyEndue(), state: "ready", agents: [agent] });
    const base = s.get();
    const here = base.wm.here;
    // A window with no tabs shows the view its id names (tabsOf).
    const leaf = { id: "endue-agent:ag_1" };
    s.set({
      wm: {
        ...base.wm,
        windows: { ...base.wm.windows, [here]: [leaf as never] },
      },
    });
    expect(viewTitles(s, tr)["endue-agent:ag_1"]).toBe("Scout");
  });
});
