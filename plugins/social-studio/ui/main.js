// Social Studio: every social account the endue account connects (Instagram, Threads, X, Reddit…)
// in one window, read from the desk's index. It uses only the public SDK and bridge API, exactly
// as a community plugin would.
import "@endue-ai/ui";
import { defineUiPlugin } from "@endue-ai/plugin-sdk";
import { mountStudio } from "./app.js";

defineUiPlugin({
  async mount(ctx) {
    await mountStudio(ctx, document);
  },
});
