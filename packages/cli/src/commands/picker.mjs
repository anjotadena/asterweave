// One-shot picker used by `auth login` when no plane is given. A thin view over the shared terminal
// lifecycle and picker in tui/session.mjs (withTerminal + pickOne): SIGINT, Ctrl+C and closed input
// all resolve `{interrupted: true}`, and the terminal is ALWAYS restored.

import { createStyle, frame, renderPicker, renderStrip } from "../tui/render.mjs";
import { pickOne as pickIndex, withTerminal } from "../tui/session.mjs";
import { createTerminal } from "../tui/terminal.mjs";

/**
 * @param {{stdin: any, stdout: any, env?: any, version?: string, proc?: any}} ctx
 * @param {{title: string, items: Array<{label: string, hint?: string}>, note?: string, header?: string}} view
 * @returns {Promise<{index: number} | {done: true, cancelled: true} | {done: true, interrupted: true}>}
 */
export async function pickOne(ctx, { title, items, note = "", header = "Asterweave" }) {
  const terminal = createTerminal({ stdin: ctx.stdin, stdout: ctx.stdout, env: ctx.env });
  const style = createStyle({ env: ctx.env, isTTY: true });
  return withTerminal({ terminal, stdin: ctx.stdin, proc: ctx.proc ?? process }, ({ input, signal }) =>
    pickIndex({
      terminal, input, signal, count: items.length,
      render: (index, { columns: width }) =>
        frame({
          header: `${header} v${ctx.version ?? "?"}`,
          body: [renderPicker({ title, items, selected: index, width, style }), ...(note ? ["", note] : [])],
          footer: renderStrip({ items: [{ key: "Up/Down", label: "move" }, { key: "Enter", label: "confirm" }, { key: "Esc", label: "cancel" }], width, style }),
          width,
        }),
    }));
}
