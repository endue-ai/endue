// One turn of Eris's as her card shows it (FT-06, ADR 0409): a row per component in the order she
// first went to it, calls folded into their row, and how each row and the turn ended.
import { describe, expect, it } from "vitest";
import type { BrainStep } from "../bridge/types";
import { componentOf, TurnModel } from "./turn-model";

const call = (callId: string, command: string, provider: string, title?: string) => ({
  out: { kind: "tool", callId, command, provider, ...(title ? { title } : {}) } as BrainStep,
  back: (ok = true, message?: string) =>
    ({
      kind: "tool-result",
      callId,
      command,
      provider,
      ok,
      ...(message ? { message } : {}),
    }) as BrainStep,
});

describe("the turn's rows", () => {
  it("calls_to_one_component_fold_into_its_row", () => {
    const turn = new TurnModel("Tidy my mail", 0);
    const a = call("c1", "endue.mail.latest", "endue.mail", "Latest mail");
    const b = call("c2", "endue.files.list", "endue.files", "List files");
    const c = call("c3", "endue.mail.archive", "endue.mail", "Archive mail");
    turn.step(a.out, 0);
    turn.step(b.out, 10);
    turn.step(a.back(), 200);
    turn.step(c.out, 300);
    const rows = turn.rows();
    expect(rows.map((r) => [r.name, r.calls, r.state])).toEqual([
      ["Mail", 2, "working"],
      ["Files", 1, "working"],
    ]);
    expect(rows[0]?.title).toBe("Archive mail");
    turn.step(c.back(), 900);
    turn.step(b.back(), 950);
    expect(turn.rows().map((r) => [r.state, r.took])).toEqual([
      ["done", 900],
      ["done", 940],
    ]);
    expect(turn.counts()).toEqual({ over: 2, total: 2, failed: 0, steps: 3 });
  });

  it("a_desk_command_that_names_a_window_is_that_windows_row", () => {
    const turn = new TurnModel("Put the notes beside the calendar", 0);
    const files = call("c0", "endue.files.list", "endue.files");
    const place = call("c1", "desk.windows.place", "desk", "Place a window");
    turn.step(files.out, 0);
    turn.step(place.out, 5);
    expect(turn.rows().map((r) => r.key)).toEqual(["plugin:endue.files", "plugin:desk"]);
    // The desk runs it and its arguments name the window: the row is that window's, in its place.
    turn.hint("desk.windows.place", { window: { id: "w-notes", title: "Notes" } });
    const rows = turn.rows();
    expect(rows.map((r) => [r.key, r.kind, r.name, r.window])).toEqual([
      ["plugin:endue.files", "plugin", "Files", undefined],
      ["window:w-notes", "window", "Notes", "w-notes"],
    ]);
    // A plugin's call that names its window keeps the plugin's row and shows the window's title.
    turn.hint("endue.files.list", { window: { id: "w-files", title: "Downloads" } });
    expect(turn.rows()[0]).toMatchObject({ key: "plugin:endue.files", place: "Downloads" });
  });

  it("an_endue_ask_is_the_agents_row", () => {
    const turn = new TurnModel("Ask Mina's agent about lunch", 0);
    const ask = call("c1", "desk.endue.ask", "desk", "Ask an endue agent");
    turn.step(ask.out, 0);
    turn.hint("desk.endue.ask", { agent: { id: "agent-mina", name: "Mina" } });
    expect(turn.rows()).toMatchObject([
      { key: "endue:agent-mina", kind: "endue", name: "Mina", agent: "agent-mina" },
    ]);
    const local = componentOf(
      { command: "desk.agents.ask", provider: "desk" },
      { agent: { id: "codex", name: "Codex" } },
    );
    expect(local).toMatchObject({ key: "agent:codex", kind: "agent", name: "Codex" });
  });

  it("a_failed_step_says_the_commands_message", () => {
    const turn = new TurnModel("Read the report", 0);
    const read = call("c1", "endue.files.read", "endue.files", "Read a file");
    turn.step(read.out, 0);
    turn.step(read.back(false, "no such file: report.md"), 50);
    expect(turn.rows()[0]).toMatchObject({
      state: "failed",
      message: "no such file: report.md",
    });
    expect(turn.counts().failed).toBe(1);
  });
});

describe("how a turn ends", () => {
  it("windows the line names wait in rows before the first call", () => {
    const about = [
      { key: "window:w1", kind: "window" as const, name: "Mail", window: "w1" },
      { key: "window:w2", kind: "window" as const, name: "Notes", window: "w2" },
    ];
    const turn = new TurnModel("Go through these", 0, about);
    expect(turn.rows().map((r) => r.state)).toEqual(["waiting", "waiting"]);
  });

  it("stop leaves every row done, failed, stopped or sent", () => {
    const turn = new TurnModel("Do several things", 0, [
      { key: "window:w9", kind: "window", name: "Later", window: "w9" },
    ]);
    const mail = call("c1", "endue.mail.send", "endue.mail", "Send mail");
    const agent = call("c2", "desk.agents.ask", "desk", "Hand an agent work");
    const files = call("c3", "endue.files.list", "endue.files");
    turn.step(mail.out, 0);
    turn.step(agent.out, 0);
    turn.hint("desk.agents.ask", { agent: { id: "codex", name: "Codex" } });
    turn.step(files.out, 0);
    turn.step(files.back(), 10);
    turn.end({ text: "Stopped.", reason: "stopped" }, 20);
    expect(turn.rows().map((r) => [r.name, r.state])).toEqual([
      ["Later", "stopped"],
      ["Mail", "sent"],
      ["Codex", "stopped"],
      ["Files", "done"],
    ]);
    expect(turn.outcome).toBe("stopped");
  });

  it("a row waits for the person while its approval is open", () => {
    const turn = new TurnModel("Save it", 0);
    const save = call("c1", "endue.files.write", "endue.files", "Save a file");
    turn.step(save.out, 0);
    const before = turn.key();
    turn.needs("a-1", true);
    expect(turn.rows()[0]?.state).toBe("needs");
    expect(turn.key()).not.toBe(before);
    turn.needs("a-1", false);
    expect(turn.rows()[0]?.state).toBe("working");
    // Her answer filling does not change what is announced.
    const key = turn.key();
    turn.delta("Saving");
    expect(turn.key()).toBe(key);
  });
});
