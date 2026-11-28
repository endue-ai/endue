// @vitest-environment jsdom
// Settings, Connections: the connectors connector.list lists, each instance with its status, a form
// drawn from the connector's instanceSettings (a password field for a secret one, emptied once the
// call is made), and sync and disconnect. The stub bridge answers as the core does.
import { BridgeClient, browserStub, stubCommands } from "@endue-ai/bridge";
import { afterEach, describe, expect, it } from "vitest";
import { accountStub } from "../bridge/account-stub";
import { mountConnections } from "./connections";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function mount(focus?: { connector?: string; kinds?: string[] }) {
  const core = stubCommands(() => {});
  const bridge = new BridgeClient(browserStub(core.handlers));
  const panel = mountConnections({ bridge, language: "en", ...(focus ? { focus } : {}) });
  document.body.append(panel.el);
  return { bridge, panel };
}

const rows = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>("[data-instance]")].map((row) => [
    row.dataset.instance,
    row.querySelector(".connection-state")?.textContent,
  ]);

afterEach(() => {
  document.body.replaceChildren();
});

/** Connections with the endue account served too, as a desk signed in to endue ID. */
function mountWithAccount() {
  const core = stubCommands(() => {});
  const opened: string[] = [];
  const account = accountStub((event) => stub.emit(event));
  const stub = browserStub({
    ...core.handlers,
    ...account.handlers,
    "shell.open": ({ target }) => {
      opened.push(target);
      return { opened: true as const };
    },
  });
  const bridge = new BridgeClient(stub);
  const panel = mountConnections({ bridge, language: "en" });
  document.body.append(panel.el);
  return { bridge, panel, opened, calls: () => stub.calls.map((c) => c.method) };
}

describe("Settings, Connections", () => {
  it("the endue account section turns on, shows what the desk may do and turns off", async () => {
    const { panel, opened, calls } = mountWithAccount();
    await panel.ready;
    const section = panel.el.querySelector<HTMLElement>("[data-endue-connectors]");
    if (!section) throw new Error("no endue account section");
    const button = (key: string) => section.querySelector<HTMLButtonElement>(`[data-key="${key}"]`);
    expect(section.querySelector("h2")?.textContent).toBe("endue account");
    expect(section.textContent).toContain("Nothing is sent to endue until you turn it on.");
    expect(section.querySelectorAll("[data-endue-connector]")).toHaveLength(0);
    // The section comes first, above the desk's own connectors.
    expect(panel.el.firstElementChild).toBe(section);
    // Turned on: one filled button became an outline Turn off, and the key reads only.
    const on = button("endue-connectors-on");
    expect(on?.classList.contains("btn-primary")).toBe(true);
    on?.click();
    await panel.idle();
    expect(calls()).toContain("account.connectors.enable");
    expect(section.textContent).toContain("This desk may read.");
    expect(section.textContent).toContain("Its key was made on");
    const rows = [...section.querySelectorAll<HTMLElement>("[data-endue-connector]")];
    expect(rows.map((r) => r.querySelector("span")?.textContent)).toEqual(["@ada.studio", "@ada"]);
    expect(rows[0]?.textContent).toContain("Works, with 3 tools.");
    expect(rows[1]?.textContent).toContain("Expired. Reconnect it on endue.ai.");
    expect(rows[0]?.querySelector("button")).toBeNull();
    rows[1]?.querySelector<HTMLButtonElement>('[data-key="endue-connector-reconnect"]')?.click();
    await panel.idle();
    expect(opened).toEqual(["https://endue.ai/resources/connectors"]);
    expect(section.querySelectorAll(".btn-primary")).toHaveLength(0);
    // Turned off: the connectors go and the key with them.
    button("endue-connectors-off")?.click();
    await panel.idle();
    expect(calls()).toContain("account.connectors.disable");
    expect(section.querySelectorAll("[data-endue-connector]")).toHaveLength(0);
    expect(button("endue-connectors-on")).not.toBeNull();
    expect(section.textContent).not.toMatch(/sk_/);
    panel.dispose();
  });

  it("shows no endue account section on a desk without an endue ID", async () => {
    const { panel } = mount();
    await panel.ready;
    expect(panel.el.querySelector("[data-endue-connectors]")?.childElementCount ?? 0).toBe(0);
    panel.dispose();
  });

  it("lists every connector with its instances and their status", async () => {
    const { panel } = mount();
    await panel.ready;
    const group = panel.el.querySelector<HTMLElement>('[data-connector="desk.fixtures"]');
    expect(group?.querySelector("h2")?.textContent).toBe("Fixtures");
    expect(group?.textContent).toContain("events, tasks, notes and messages");
    expect(rows(panel.el)).toEqual([["desk.fixtures/default", "Connected"]]);
    panel.dispose();
  });

  it("connects an instance with a password field it empties after the call", async () => {
    const { bridge, panel } = mount();
    await panel.ready;
    const form = panel.el.querySelector<HTMLFormElement>('form[data-connect="desk.fixtures"]');
    if (!form) throw new Error("no connect form");
    const field = (name: string) =>
      form.querySelector<HTMLInputElement>(`[name="${name}"]`) ?? undefined;
    expect(field("token")?.type).toBe("password");
    expect(field("token")?.autocomplete).toBe("off");
    expect(field("folder")?.type).toBe("text");
    const name = field("title");
    if (!name) throw new Error("no name field");
    name.value = "Work";
    (field("folder") as HTMLInputElement).value = "~/Work";
    (field("token") as HTMLInputElement).value = "s3cret";
    form.requestSubmit();
    await panel.idle();
    expect(field("token")?.value).toBe("");
    const listed = await bridge.call("connector.list", {
      scope: { permission: "connector:manage" },
    });
    const work = listed.connectors[0]?.instances.find((i) => i.instance === "work");
    expect(work).toMatchObject({ title: "Work", settings: { folder: "~/Work" } });
    expect(JSON.stringify(listed)).not.toContain("s3cret");
    await settle();
    await panel.idle();
    expect(rows(panel.el).map(([id]) => id)).toEqual([
      "desk.fixtures/default",
      "desk.fixtures/work",
    ]);
    expect(panel.el.textContent).not.toContain("s3cret");
    panel.dispose();
  });

  it("says why a connect was refused and still empties the secret", async () => {
    // No name is the instance `default`, which the fixture connector already has.
    const { panel } = mount();
    await panel.ready;
    const form = panel.el.querySelector<HTMLFormElement>('form[data-connect="desk.fixtures"]');
    if (!form) throw new Error("no connect form");
    const title = form.querySelector<HTMLInputElement>('[name="title"]');
    const token = form.querySelector<HTMLInputElement>('[name="token"]');
    if (!title || !token) throw new Error("fields missing");
    title.value = "";
    token.value = "again";
    form.requestSubmit();
    await panel.idle();
    expect(form.querySelector('[role="alert"]')?.textContent).toContain("already");
    expect(token.value).toBe("");
    panel.dispose();
  });

  it("syncs and disconnects an instance", async () => {
    const { bridge, panel } = mount();
    await panel.ready;
    const row = panel.el.querySelector<HTMLElement>('[data-instance="desk.fixtures/default"]');
    const button = (label: string) =>
      [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent === label);
    button("Sync now")?.click();
    await panel.idle();
    button("Disconnect")?.click();
    await panel.idle();
    const listed = await bridge.call("connector.list", {
      scope: { permission: "connector:manage" },
    });
    expect(listed.connectors[0]?.instances).toEqual([]);
    await settle();
    await panel.idle();
    expect(rows(panel.el)).toEqual([]);
    panel.dispose();
  });

  it("puts the connector desk.connectors.open names first and opens its form", async () => {
    const { panel } = mount({ connector: "desk.fixtures" });
    await panel.ready;
    const first = panel.el.querySelector<HTMLElement>("[data-connector]");
    expect(first?.dataset.connector).toBe("desk.fixtures");
    expect(first?.classList.contains("focused")).toBe(true);
    panel.dispose();
  });
});
