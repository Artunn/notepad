// Notes sidebar, Apple Notes style: folders and their notes in one column.
// Notes are plain .md files in ~/Notes (loose ones) and ~/Notes/<folder>/.
// The picked note shows in one `note` tab (shared "notepad.tabs": { file: tab id }, one entry), the
// way the agents list shows one agent at a time; drag a note onto
// a folder (or onto "Notes") to move it; right-click a note for Rename, Delete (to ~/Notes/.Trash).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { nextCommand, theme, run, exec, home, readTextFile, writeTextFile, watchFolder, spaces, panes, focused, shared, setShared, layout, notify } from "herdr";
import * as fs from "fs/promises";

const ICON = (n) => `mods/workspace-chrome/${n}.svg`;

export function title(text) {
  const line = (text ?? "").split("\n").find((l) => l.trim());
  return line ? line.replace(/^#+\s*/, "").trim() : "New Note";
}

// A note's name is its first line (Apple Notes): renaming replaces that line.
export function retitle(text, name) {
  const lines = (text ?? "").split("\n");
  const i = lines.findIndex((l) => l.trim());
  if (i < 0) return name + (text ? `\n${text}` : "");
  lines[i] = name;
  return lines.join("\n");
}

// The note tab, file -> tab id, while that tab still holds a note editor.
function noteTabs() {
  const live = new Set(panes().filter((p) => p.mod === "notepad-note").map((p) => p.tab));
  return Object.fromEntries(Object.entries(shared("notepad.tabs") ?? {}).filter(([, tab]) => live.has(tab)));
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

export default class Notes extends View {
  init(_props, cx) {
    this.root = `${home()}/Notes`;
    this.folders = []; // [{ name: "" (loose notes) | folder, notes: [{ file, title }] }]
    this.open = new Set(JSON.parse(localStorage.getItem("open") ?? '[""]'));
    this.selected = ""; // where a new note goes
    this.dragging = null; // file being dragged
    this.over = null; // folder under the pointer while dragging
    this.menu = null; // row showing its Delete button
    this.naming = false;
    this.input = InputState.new({ placeholder: "Folder name" });
    this.input.on("submit", (_e, cx) => this.makeFolder(cx));
    this.input.on("blur", (_e, cx) => { this.naming = false; cx.notify(); });
    this.renaming = null; // note being renamed
    this.pending = null; // { file, before }: a note tab asked for, not yet seen
    this.picked = new Set(); // notes selected with shift / cmd click
    this.anchor = null; // where a shift-click range starts
    this.visible = []; // note files in the order the list shows them
    this.renameInput = InputState.new({ placeholder: "Note name" });
    this.renameInput.on("submit", (_e, cx) => this.rename(cx));
    this.renameInput.on("blur", (_e, cx) => { this.renaming = null; cx.notify(); });
    // keys.json "layout:notes": { "ctrl-n": "notepad.new" }
    cx.spawn(async (cx) => { for (;;) { if ((await nextCommand()) === "new") this.newNote(cx); } });
    this.polling = false; // the folder watch was refused: reload on a timer instead
    cx.spawn(async (cx) => {
      try { await exec("mkdir", ["-p", `${this.root}/.Trash`]); }
      catch (e) { return notify({ title: "Notes", body: String(e?.message ?? e), level: "error" }); }
      for (;;) {
        await this.reload(cx);
        try { await watchFolder(this.root); } catch { this.polling = true; return; }
      }
    });
    cx.timer.every(5000, (cx) => { if (this.polling) cx.spawn((cx) => this.reload(cx)); });
  }

  // shortcut: rereads every note on each change; fine for hundreds, cache by file if it gets slow.
  async load() {
    const notes = async (dir) => {
      const names = (await fs.readdir(dir)).filter((n) => n.endsWith(".md")).sort().reverse(); // newest first
      return Promise.all(names.map(async (n) => ({ file: `${dir}/${n}`, title: title(await readTextFile(`${dir}/${n}`)) })));
    };
    const dirs = (await fs.readdir(this.root, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name).sort((a, b) => a.localeCompare(b));
    this.folders = await Promise.all(["", ...dirs].map(async (name) => ({ name, notes: await notes(this.dir(name)) })));
  }

  async reload(cx) {
    try { await this.load(); } catch (e) { console.log(`notes: ${e?.message ?? e}`); }
    cx.notify();
  }

  dir(name) { return name ? `${this.root}/${name}` : this.root; }

  openNote(file, name = "New Note") {
    const [shown, tab] = Object.entries(noteTabs())[0] ?? [];
    if (tab) {
      // The one note tab shows this note now: its editor saves the last one and loads this.
      if (shown !== file) setShared("notepad.tabs", { [file]: tab });
      return run("tab.select", { id: tab });
    }
    // focused() still names the old tab right after tab.new: the new tab is learnt in render,
    // as the one that wasn't there before.
    this.pending = { file, before: new Set(spaces().flatMap((s) => s.tabs.map((t) => t.id))) };
    run("tab.new", { name: name.slice(0, 40), mod: "notepad-note", props: { file } });
  }

  // One note tab at a time, like the agents list: the new one is mapped, older note-only tabs close
  // (their editors save on close). A tab someone split a terminal into stays.
  adopt() {
    const { file, before } = this.pending;
    const all = spaces().flatMap((s) => s.tabs);
    const editors = new Set(panes().filter((p) => p.mod === "notepad-note").map((p) => p.tab));
    const tab = all.find((t) => !before.has(t.id) && editors.has(t.id))?.id;
    if (!tab) return;
    this.pending = null;
    const single = new Set(all.filter((t) => t.panes === 1).map((t) => t.id));
    const old = [...editors].filter((id) => id !== tab && single.has(id));
    for (const id of old) run("tab.close", { id, confirmed: true });
    setShared("notepad.tabs", { [file]: tab });
  }

  closeNote(file) {
    const tabs = noteTabs();
    if (tabs[file]) run("tab.close", { id: tabs[file], confirmed: true });
  }

  rename(cx) {
    const file = this.renaming, name = this.renameInput.value().trim();
    this.renaming = null;
    if (!file || !name) return cx.notify();
    // An open editor renames in its own text (it owns the file while open); else write here.
    if (noteTabs()[file]) { setShared("notepad.rename", { file, name, at: Date.now() }); return cx.notify(); }
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(file);
        await writeTextFile(file, retitle(text, name), text);
      } catch (e) { notify({ title: "Couldn't rename note", body: String(e?.message ?? e), level: "error" }); }
      await this.load(); cx.notify();
    });
  }

  newNote(cx) {
    cx.spawn(async (cx) => {
      const file = `${this.dir(this.selected)}/${Date.now()}.md`;
      await writeTextFile(file, "", null);
      this.open.add(this.selected); this.save();
      this.openNote(file);
      await this.load(); cx.notify();
    });
  }

  makeFolder(cx) {
    const name = this.input.value().trim().replace(/[/\\]/g, "-").replace(/^\.+/, "");
    this.naming = false;
    this.input.set_value("");
    if (!name) return cx.notify();
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", this.dir(name)]);
      this.selected = name; this.open.add(name); this.save();
      await this.load(); cx.notify();
    });
  }

  // mv -n never overwrites; the editor follows a moved note by its file name.
  move(from, toDir, cx) {
    cx.spawn(async (cx) => {
      const to = `${toDir}/${from.split("/").pop()}`;
      const r = await exec("mv", ["-n", from, to]);
      if (r.code !== 0) notify({ title: "Couldn't move note", body: r.stderr, level: "error" });
      else if (toDir.endsWith("/.Trash")) this.closeNote(from);
      else {
        // The open tab follows: its editor finds its new file by its tab id.
        const tabs = noteTabs();
        if (tabs[from]) { tabs[to] = tabs[from]; delete tabs[from]; setShared("notepad.tabs", tabs); }
      }
      await this.load(); cx.notify();
    });
  }

  // Click: open it (and select only it). Shift: everything from the last click to here.
  // Cmd: add or drop one.
  pick(n, f, e, cx) {
    const m = e?.modifiers ?? {};
    if (m.shift && this.anchor && this.visible.includes(this.anchor)) {
      const [a, b] = [this.visible.indexOf(this.anchor), this.visible.indexOf(n.file)].sort((x, y) => x - y);
      this.picked = new Set(this.visible.slice(a, b + 1));
    } else if (m.platform) {
      this.picked.has(n.file) ? this.picked.delete(n.file) : this.picked.add(n.file);
      this.anchor = n.file;
    } else {
      this.picked = new Set([n.file]);
      this.anchor = n.file;
      this.selected = f.name;
      this.openNote(n.file, n.title);
    }
    cx.notify();
  }

  trashPicked(cx) {
    const files = [...this.picked];
    this.picked = new Set();
    cx.spawn(async (cx) => {
      for (const file of files) {
        const r = await exec("mv", ["-n", file, `${this.root}/.Trash/`]);
        if (r.code !== 0) notify({ title: "Couldn't delete note", body: r.stderr, level: "error" });
        else this.closeNote(file);
      }
      await this.load(); cx.notify();
    });
  }

  trashFolder(name, cx) {
    cx.spawn(async (cx) => {
      const r = await exec("mv", ["-n", this.dir(name), `${this.root}/.Trash/${name}-${Date.now()}`]);
      if (r.code !== 0) notify({ title: "Couldn't delete folder", body: r.stderr, level: "error" });
      else for (const file of Object.keys(noteTabs())) if (file.startsWith(`${this.dir(name)}/`)) this.closeNote(file);
      if (this.selected === name) this.selected = "";
      await this.load(); cx.notify();
    });
  }

  save() { localStorage.setItem("open", JSON.stringify([...this.open])); }

  button(id, icon, tip, action) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .tooltip(tip).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(action).child(svg(ICON(icon)).size(14));
  }

  pill(id, label, bg, fg, action) {
    return div().id(id).flex_none().px(6).py(1).rounded(5).text_size(11.5).bg(bg).text_color(fg)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }

  del(id, action) { return this.pill(`del-${id}`, "Delete", theme().blocked, "#ffffff", action); }

  folderRow(f, t) {
    const open = this.open.has(f.name);
    const drop = this.dragging !== null && this.over === f.name;
    const key = `folder:${f.name}`;
    return h_flex().id(`folder-${f.name || "~"}`).h(30).flex_none().px(8).gap(8).items_center().rounded(8)
      .hover((s) => s.bg(t.hover))
      .when(drop, (el) => el.border_1().border_color(t.accent))
      .on_mouse_move((_e, cx) => { if (this.dragging !== null && this.over !== f.name) { this.over = f.name; cx.notify(); } })
      .on_mouse_down("left", () => { this.dragging = null; })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.dragging;
        this.dragging = null; this.over = null;
        if (from && from.slice(0, from.lastIndexOf("/")) !== this.dir(f.name)) return this.move(from, this.dir(f.name), cx);
        if (from) return cx.notify();
        this.selected = f.name;
        open ? this.open.delete(f.name) : this.open.add(f.name);
        this.save(); this.menu = null; cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => { if (f.name) { this.menu = this.menu === key ? null : key; cx.notify(); } })
      .child(svg(ICON(`chevron-${open ? "down" : "right"}`)).size(11).flex_none().text_color(t.dim))
      .child(svg(ICON("folder")).size(15).flex_none().text_color(t.accent))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(f.name || "Notes"))
      // + : a new note in this folder. The row acts on mouse up, so this one stops both.
      .child(div().id(`folder-new-${f.name || "~"}`).flex_none().p(2).rounded(4).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(`New note in ${f.name || "Notes"}`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); this.dragging = null; this.selected = f.name; this.newNote(cx); })
        .child(svg(ICON("plus")).size(12)))
      .child(this.menu === key ? this.del(key, (_e, cx) => { this.menu = null; this.trashFolder(f.name, cx); })
        : div().flex_none().text_size(12).text_color(t.dim).child(String(f.notes.length)));
  }

  noteRow(n, f, t) {
    const live = shared("notepad.live");
    const name = live?.file === n.file ? live.title : n.title;
    const on = this.picked.size > 1 ? this.picked.has(n.file)
      : Boolean(focused()?.tab) && noteTabs()[n.file] === focused().tab;
    const key = `note:${n.file}`;
    // Element ids from the file name only (digits): no path separators or dots in ids.
    const nid = n.file.split("/").pop().replace(/\.md$/, "");
    if (this.renaming === n.file) {
      return div().id(`rename-${nid}`).pl(24).pr(4).py(1).flex_none().child(Input.new(this.renameInput).h(26).px(8).rounded(7)
        .border_1().border_color(t.accent).bg(t.background).text_size(12.5).text_color(t.foreground));
    }
    return h_flex().id(`note-${nid}`).h(28).flex_none().pl(30).pr(8).gap(8).items_center().rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.dragging === n.file && this.over !== null, (el) => el.opacity(0.5))
      .on_mouse_down("left", () => { this.dragging = n.file; this.over = null; })
      .on_mouse_move((_e, cx) => { if (this.dragging !== null && this.over !== null) { this.over = null; cx.notify(); } })
      .on_mouse_up("left", (e, cx) => {
        const from = this.dragging;
        this.dragging = null; this.over = null; this.menu = null;
        if (from === n.file) return this.pick(n, f, e, cx);
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => { this.menu = this.menu === key ? null : key; cx.notify(); })
      .child(svg(ICON("file-text")).size(13).flex_none().text_color(t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(name))
      .when(this.menu === key, (el) => el
        .child(this.pill(`rename-pill-${nid}`, "Rename", t.raised, t.foreground, (_e, cx) => {
          this.menu = null; this.renaming = n.file;
          this.renameInput.set_value(n.title === "New Note" ? "" : n.title); this.renameInput.focus(); cx.notify();
        }))
        .child(this.del(`note-${nid}`, (_e, cx) => { this.menu = null; this.move(n.file, `${this.root}/.Trash`, cx); })));
  }

  render() {
    const t = theme();
    if (this.pending) this.adopt();
    if (narrow()) {
      return v_flex().size_full().bg(t.chrome).items_center().pt(4)
        .child(this.button("note-new", "square-pen", "New note", (_e, cx) => this.newNote(cx)));
    }
    this.visible = this.folders.flatMap((f) => (this.open.has(f.name) ? f.notes.map((n) => n.file) : []));
    for (const file of this.picked) if (!this.visible.includes(file)) this.picked.delete(file);
    const rows = this.folders.flatMap((f) => [
      this.folderRow(f, t),
      ...(this.open.has(f.name) ? f.notes.map((n) => this.noteRow(n, f, t)) : []),
    ]);
    return v_flex().id("notes").size_full().min_h(0).bg(t.chrome).text_size(13)
      // A drag only lasts while pressed in the list: a press or release elsewhere ends it.
      .on_mouse_down_out((_e, cx) => { if (this.dragging !== null) { this.dragging = null; this.over = null; cx.notify(); } })
      .child(h_flex().h(31).pl(16).pr(10).gap(2).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_1().child("Notes"))
        .child(this.button("folder-new", "folder-plus", "New folder", (_e, cx) => { this.naming = true; this.input.focus(); cx.notify(); }))
        .child(this.button("note-new", "square-pen", "New note", (_e, cx) => this.newNote(cx))))
      .when(this.picked.size > 1, (el) => el.child(h_flex().mx(8).mb(4).px(10).h(30).gap(8).items_center().rounded(8).bg(t.raised).text_size(12.5)
        .child(div().flex_1().text_color(t.foreground).child(`${this.picked.size} selected`))
        .child(this.pill("picked-delete", "Delete", t.blocked, "#ffffff", (_e, cx) => this.trashPicked(cx)))
        .child(this.pill("picked-cancel", "Cancel", t.hover, t.foreground, (_e, cx) => { this.picked = new Set(); cx.notify(); }))))
      .when(this.naming, (el) => el.child(div().px(8).pb(4).child(Input.new(this.input).h(28).px(8).rounded(7)
        .border_1().border_color(t.accent).bg(t.background).text_size(12.5).text_color(t.foreground))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().size_full().px(8).pb(48).overflow_y_scrollbar()
          .on_mouse_up("left", (_e, cx) => { if (this.dragging !== null) { this.dragging = null; this.over = null; cx.notify(); } })
          .children(rows))
        // New note, bottom right.
        .child(div().id("note-new-corner").absolute().right(12).bottom(10).size(32).rounded_full().flex().items_center().justify_center()
          .bg(t.solid).text_color(t.solid_foreground).cursor_pointer().hover((s) => s.opacity(0.88)).tooltip("New note (Ctrl+N)")
          .on_click((_e, cx) => this.newNote(cx)).child(svg(ICON("plus")).size(16))));
  }
}
