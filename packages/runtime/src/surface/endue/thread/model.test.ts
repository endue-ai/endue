import type { StudioChatEventData, StudioMessage } from "@endue-ai/bridge";
import { describe, expect, test } from "vitest";
import {
  applyEvent,
  emptyThread,
  newLineAt,
  sent,
  tryAgain,
  used,
  when,
  withPage,
  workLine,
} from "./model";

const AT = "2026-11-09T09:00:00Z";
const NOW = Date.parse(AT);
const ev = (kind: StudioChatEventData["kind"], more: Partial<StudioChatEventData> = {}) => ({
  conversationId: "cnv_1",
  runId: "run_1",
  kind,
  ...more,
});
const msg = (id: string, role: StudioMessage["role"], minutesAgo: number): StudioMessage => ({
  id,
  role,
  text: id,
  createdAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
});

describe("an agent's thread (ADR 0411)", () => {
  test("deltas_grow_the_answer_in_flight", () => {
    let t = sent(emptyThread("cnv_1"), "Plan my week", "msg_me_1", AT);
    t = applyEvent(t, ev("started"), AT);
    t = applyEvent(t, ev("delta", { text: "Here is " }), AT);
    t = applyEvent(t, ev("delta", { text: "the plan." }), AT);
    expect(t.run).toMatchObject({ runId: "run_1", text: "Here is the plan.", state: "working" });
    t = applyEvent(t, ev("completed", { text: "Here is the plan." }), AT);
    expect(t.run).toBeUndefined();
    expect(t.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "Plan my week"],
      ["assistant", "Here is the plan."],
    ]);
  });

  test("the_new_messages_line_falls_at_the_previous_read", () => {
    const messages = [
      msg("a", "user", 30),
      msg("b", "assistant", 29),
      msg("c", "user", 3),
      msg("d", "assistant", 2),
    ];
    const read = new Date(NOW - 10 * 60_000).toISOString();
    expect(newLineAt(messages, read)).toBe(3);
    expect(newLineAt(messages)).toBe(-1);
    expect(newLineAt(messages, AT)).toBe(-1);
  });

  test("times_read_as_endue_ai_writes_them", () => {
    const ago = (ms: number) => new Date(NOW - ms).toISOString();
    expect(when("en", ago(20_000), NOW)).toBe("just now");
    expect(when("en", ago(5 * 60_000), NOW)).toBe("5m");
    expect(when("en", ago(3 * 3_600_000), NOW)).toBe("3h");
    expect(when("en", ago(24 * 3_600_000), NOW)).toBe("yesterday");
    expect(when("en", "2026-11-01T09:00:00Z", NOW)).toBe("Nov 1");
    expect(when("ko", ago(5 * 60_000), NOW)).toBe("5분");
    expect(when("ko", ago(24 * 3_600_000), NOW)).toBe("어제");
  });

  test("a_failed_run_offers_try_again", () => {
    let t = sent(emptyThread("cnv_1"), "Find flights", "msg_me_1", AT);
    expect(tryAgain(t)).toBeUndefined();
    t = applyEvent(t, ev("failed", { message: "the model timed out" }), AT);
    expect(t.run).toMatchObject({ state: "failed", message: "the model timed out" });
    expect(tryAgain(t)).toBe("Find flights");
  });

  test("a stop keeps what was written and says it stopped", () => {
    let t = sent(emptyThread("cnv_1"), "Draft it", "msg_me_1", AT);
    t = applyEvent(t, ev("delta", { text: "Dear team," }), AT);
    t = applyEvent(t, ev("cancelled"), AT);
    expect(t.stopped).toBe(true);
    expect(t.messages.at(-1)?.text).toBe("Dear team,");
  });

  test("older pages go before what is held, newest first as read", () => {
    let t = withPage(
      emptyThread("cnv_1"),
      { messages: [msg("d", "assistant", 1), msg("c", "user", 2)], hasMore: true },
      false,
    );
    t = withPage(
      t,
      { messages: [msg("b", "assistant", 3), msg("a", "user", 4)], hasMore: false },
      true,
    );
    expect(t.messages.map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
    expect(t.hasMore).toBe(false);
    expect(t.reading).toBe(false);
  });

  test("the work reads as one line, and what was used as chips", () => {
    const work = {
      phase: "completed",
      startedAt: "2026-11-09T08:59:46Z",
      endedAt: AT,
      attempted: 3,
      succeeded: 1,
      failed: 2,
      groups: [
        { label: "Search the web", calls: 2, failed: 2 },
        { label: "Read a page", calls: 1, failed: 0 },
      ],
    };
    expect(workLine("en", work, NOW, false)).toBe("Work completed · 14 s · 3 tools");
    expect(workLine("en", work, NOW, true)).toBe("Working · Read a page");
    expect(used(work, 1)).toEqual({ labels: ["Search the web"], more: 1 });
  });
});
