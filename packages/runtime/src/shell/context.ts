import type { BrainTurnReason } from "../bridge/types";
import type { ErisState } from "../eris/states";
import type { TurnHandle } from "../eris/turn";
import type { Platform } from "../input";
import type { PluginWindows } from "../surface/host";
import type { WindowDocs } from "../surface/window-docs";
import type { HeldWindows, WindowManagerHost } from "../wm/host";
import type { Ctx } from "./actions";
import type { CopyKey } from "./copy";
import type { Ticker } from "./ticker";

/** What every shell part gets: the store, the bridges, the runtime, the frame loop, copy and keys. */
export interface ShellCtx extends Ctx {
  ticker: Ticker;
  tr(key: CopyKey, vars?: Record<string, string | number>): string;
  /** Reduced motion, as desk.theme says. */
  reduced(): boolean;
  /** Wall-clock milliseconds now: the epoch the shell started at plus the clock's time. */
  wall(): number;
  platform: Platform;
  /** The first key bound to a command, as people read it on this platform. */
  keyOf(command: string): string | undefined;
  /** The plugin surfaces the runtime handed to the shell's windows (ADR 0040). */
  windows: PluginWindows;
  /** The host that runs the window manager's gestures and commands (the compositor, ADR 0153). */
  wm: WindowManagerHost;
  /** Where the page lays out the window the host's gesture holds. */
  held: HeldWindows;
  /** Where each window's DOM lies, this page or a page of its own (ADR 0201); absent in a desk without. */
  pages?: WindowDocs;
  /** Eris's controls for parts that make her react (the composer, the rail). */
  eris: {
    say(text: string, words?: { word: string; at: number }[]): void;
    /** A turn that failed: her sentence, kept with what fixes it, and her oops (FT-01). */
    fail?(text: string, reason: BrainTurnReason): void;
    setState(state: ErisState): void;
    /** Start or end a spoken turn (FT-02), as a click on her does; the talk line's microphone. */
    talk?(): void;
    /** A typed line's turn, shown on her card (FT-06); `about`, the windows the line names. */
    turn?(line: string, about?: string[]): TurnHandle | undefined;
  };
}

/** Desk size in CSS pixels; layout positions are given in this 1440×900 frame. */
export const REFERENCE = { width: 1440, height: 900 } as const;
