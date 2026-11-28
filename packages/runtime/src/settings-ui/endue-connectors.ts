/**
 * Settings, Connections, "endue account": "Use my endue connectors on this desk" (ADR 0407). Off,
 * it sends nothing. Turning it on has the core make a key of the desk's own, read only, kept in the
 * OS keychain; the section says what the key may do, when it was made, and the connectors it sees,
 * an expired one with the endue.ai page that reconnects it. No key ever reaches this page. A desk
 * without an endue ID shows no section.
 */
import {
  type AccountConnector,
  type AccountConnectorPower,
  type AccountConnectors,
  BridgeCallError,
  type BridgeClient,
} from "@endue-ai/bridge";
import { type KeyOf, moduleText } from "../i18n/messages";
import { h, render } from "../shell/dom";
import type { SettingsLanguage } from "./copy";
import en from "./messages/en.json";
import ko from "./messages/ko.json";

const SCOPE = { permission: "account:manage" } as const;

const text = moduleText("settingsUi", { en, ko });
type Id = KeyOf<keyof typeof en, "settingsUi">;
type Copy = KeyOf<Id, "endueConnectors">;

export interface EndueConnectorsSection {
  el: HTMLElement;
  ready: Promise<void>;
  idle(): Promise<void>;
  dispose(): void;
}

/** What the key may do, as one sentence: "This desk may read and publish." */
export function mayLine(language: SettingsLanguage, may: AccountConnectorPower[]): string {
  const tr = (key: Copy) => text(language, `endueConnectors.${key}` as Id);
  const words = may.map((power) => tr(`may.${power}` as Copy));
  const list =
    words.length < 2
      ? words.join("")
      : `${words.slice(0, -1).join(", ")}${tr("lastAnd")}${words.at(-1)}`;
  return text(language, "endueConnectors.mayLine", { list });
}

export function mountEndueConnectors(options: {
  bridge: BridgeClient;
  language: SettingsLanguage;
}): EndueConnectorsSection {
  const { bridge, language } = options;
  const tr = (key: Copy, vars?: Record<string, string>) =>
    text(language, `endueConnectors.${key}` as Id, vars);
  const el = h("section", {
    class: "settings-group connection connection-endue",
    "data-endue-connectors": "",
  });
  let state: AccountConnectors | undefined;
  let served = true;
  let alert = "";
  let pending: Promise<void> = Promise.resolve();
  let disposed = false;

  const load = async () => {
    if (disposed) return;
    try {
      state = await bridge.call("account.connectors.status", { scope: SCOPE });
    } catch (error) {
      // A desk without an endue ID serves no account.*: the section stays away.
      served = !(error instanceof BridgeCallError && error.code === "unsupported");
      state = undefined;
    }
    draw();
  };
  const queue = (work: () => Promise<AccountConnectors | undefined>) => {
    pending = pending.then(async () => {
      alert = "";
      try {
        const answer = await work();
        if (answer) state = answer;
      } catch (error) {
        alert = error instanceof BridgeCallError ? error.message : String(error);
      }
      draw();
    });
    return pending;
  };
  const turnOn = () => queue(() => bridge.call("account.connectors.enable", { scope: SCOPE }));
  const turnOff = () => queue(() => bridge.call("account.connectors.disable", { scope: SCOPE }));
  const reconnect = (url: string) =>
    queue(async () => {
      await bridge.call("shell.open", {
        target: url,
        scope: { permission: "shell:open", schemes: ["https"] },
      });
      return undefined;
    });

  const connectorRow = (connector: AccountConnector) => {
    const expired = connector.state === "expired";
    const name = connector.title ?? connector.name ?? connector.type;
    const line = expired
      ? tr("expired")
      : tr(connector.tools === 1 ? "worksOne" : "works", { count: String(connector.tools) });
    return h(
      "div",
      { class: "settings-row connection-instance", "data-endue-connector": connector.id },
      h(
        "div",
        { class: "settings-row-label" },
        h("span", {}, name),
        h("p", {}, `${connector.name ?? connector.type} · ${line}`),
      ),
      expired && connector.reconnectUrl
        ? h(
            "div",
            { class: "connection-actions" },
            h(
              "button",
              {
                type: "button",
                class: "btn btn-xs btn-outline",
                "data-key": "endue-connector-reconnect",
                onClick: () => void reconnect(connector.reconnectUrl as string),
              },
              tr("reconnect"),
            ),
          )
        : null,
    );
  };

  function draw() {
    render(el, () => {
      if (!served) return [];
      const on = state?.enabled === true;
      const problem = alert || state?.problem || "";
      const made =
        on && state?.createdAt
          ? ` ${tr("made", { date: new Date(state.createdAt).toLocaleDateString(language) })}`
          : "";
      return [
        h("h2", {}, tr("title")),
        h("p", { class: "settings-footnote" }, tr("hint")),
        h(
          "div",
          { class: "settings-group-rows" },
          h(
            "div",
            { class: "settings-row" },
            h(
              "div",
              { class: "settings-row-label" },
              h("span", {}, tr("use")),
              h("p", {}, on ? `${mayLine(language, state?.may ?? [])}${made}` : tr("offLine")),
            ),
            h(
              "div",
              { class: "connection-actions" },
              h(
                "button",
                {
                  type: "button",
                  class: `btn btn-xs ${on ? "btn-outline" : "btn-primary"}`,
                  "data-key": on ? "endue-connectors-off" : "endue-connectors-on",
                  onClick: () => void (on ? turnOff() : turnOn()),
                },
                tr(on ? "turnOff" : "turnOn"),
              ),
            ),
          ),
          on && (state?.connectors.length ?? 0) === 0
            ? h("p", { class: "connection-none" }, tr("none"))
            : null,
          on ? (state?.connectors ?? []).map(connectorRow) : null,
          problem ? h("p", { class: "connection-alert", role: "alert" }, problem) : null,
        ),
      ];
    });
  }

  // Signing out revokes the key; the section reads the state again.
  const off = bridge.onEvent((event) => {
    if (event.event === "account.changed") pending = pending.then(load);
  });
  const ready = load();
  pending = ready;
  return {
    el,
    ready,
    idle: () => pending,
    dispose: () => {
      disposed = true;
      off();
      el.remove();
    },
  };
}
