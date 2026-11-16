// Right-click menu of the note editor: start an agent with the selected text (props.selection,
// read by the editor as it opened this) or the whole note.

import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, props, closeOverlay, run, notify, knownAgents, readTextFile, spaces, shared, setShared } from "herdr";

// The Claude mark the note puts after text it sent; never sent itself.
const MARK = " ✻";

export default class NoteMenu extends View {
  // Close only when done: closing this copy cancels its pending calls (knownAgents, readTextFile).
  // whole: the whole note was sent (no mark in the text, only the linked-agent bar).
  async start(task, whole) {
    try {
      if (!task?.trim()) return notify({ title: "Nothing selected", body: "Select some text in the note first.", level: "warning" });
      const agent = (await knownAgents()).filter((a) => a.installed).sort((a, b) => (b.key === "claude") - (a.key === "claude"))[0];
      if (!agent) return notify({ title: "No agent installed", level: "warning" });
      // Herdr passes the task as the agent's last argument: "- item" would read as an option, so end options first.
      const text = task.split(MARK).join("").trim();
      // run() gives no ids: the note editor finds the agent's tab as the one that wasn't there before.
      const before = spaces().flatMap((s) => s.tabs.map((t) => t.id));
      run("tab.new", { name: text.split("\n")[0].slice(0, 40), argv: text.startsWith("-") ? [...agent.run, "--"] : agent.run, task: text });
      const { file, range } = props();
      const links = shared("notepad.links") ?? {};
      const id = String(Date.now());
      setShared("notepad.links", { ...links, [file]: [...(links[file] ?? []), { id, snippet: text.split("\n")[0].slice(0, 60), tab: null, before, at: Date.now() }] });
      if (!whole && range) setShared("notepad.sent", { file, range, selection: task, id });
    } catch (e) {
      notify({ title: "Couldn't start agent", body: String(e?.message ?? e), level: "error" });
    } finally {
      closeOverlay(props().overlay);
    }
  }

  render() {
    const t = theme();
    // A press on an item must not start dragging the window.
    const item = (id, label, action) => div().id(id).h(30).px(10).flex().items_center().rounded(6)
      .text_color(t.foreground).hover((s) => s.bg(t.hover)).cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
    // Opened as a window (it keeps the note's selection drawn): a press anywhere else closes it.
    return v_flex().id("note-menu").w_full().p(4).bg(t.popover).text_size(13)
      .on_mouse_down_out(() => closeOverlay(props().overlay))
      .child(item("sel", "New agent with selection", () => this.start(props().selection)))
      .child(item("all", "New agent with whole note", async () => this.start(await readTextFile(props().file), true)));
  }
}
