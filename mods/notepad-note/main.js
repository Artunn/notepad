// The note editor tab, Apple Notes style: a big title line, Enter, then the body.
// It opens with props { file } (a .md file in ~/Notes: first line the title, the rest the body)
// and saves while you type. The `notes` sidebar shows other notes in this same tab by remapping
// shared "notepad.tabs" ({ file: tab id }); this copy then saves the last note and loads the new one.
// It also follows a moved note and applies a rename asked for from the sidebar ("notepad.rename").

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea } from "gpui-base";
import { theme, props, readTextFile, writeTextFile, shared, setShared, run, notify, openOverlay, knownAgents, exec, home, spaces, agents } from "herdr";

// The Claude mark put after text sent to an agent (notepad-menu strips it from what it sends).
const MARK = " ✻";
const allTabs = () => spaces().flatMap((s) => s.tabs);

const base = (f) => f?.split("/").pop();
const title = (text) => (text.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim() || "New Note";

// "12 November 2026 at 16:06", as Apple Notes writes it (the runtime has no Intl date styles).
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n) => String(n).padStart(2, "0");
const stamp = (d) => `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} at ${pad(d.getHours())}:${pad(d.getMinutes())}`;

export default class Note extends View {
  init(_p, cx) {
    this.file = props()?.file ?? null;
    this.tab = null; // learnt from shared "notepad.tabs"
    this.saved = ""; // the file's text as last read or written
    this.loaded = false;
    this.dirty = false;
    this.named = null; // the title the tab was last given
    this.queue = Promise.resolve(); // load and saves, one at a time
    this.formatOpen = false; // the Aa menu
    // Only a real edit: setting the text from the file (load, refresh) fires change too.
    const changed = () => { if (this.loaded && this.text() !== this.saved) this.dirty = true; };
    this.head = InputState.new({ placeholder: "Title" });
    this.head.on("change", changed);
    // Enter: on to the body, and save now so the list and the tab show the title at once.
    this.head.on("submit", (_e, cx) => { this.body.focus(); this.enqueue(cx, () => this.flush()); });
    this.body = TextareaState.new({ placeholder: "" });
    this.body.set_soft_wrap(true);
    this.body.on("change", () => { changed(); this.continueList(); });
    // sync here too, not only in render: an idle window may not repaint when another note is picked.
    cx.timer.every(500, (cx) => { if (this.file) this.sync(cx); if (this.dirty) this.enqueue(cx, () => this.flush()); });
    // Picks up edits made outside (an agent improving the note) while nothing typed is unsaved.
    cx.timer.every(1500, (cx) => { if (!this.dirty && this.loaded) this.enqueue(cx, () => this.refresh()); });
    if (this.file) this.enqueue(cx, () => this.load());
  }

  // One failed step must not stop the ones after it: a rejected chain skips every later load and save.
  enqueue(cx, work) {
    this.queue = this.queue.then(work)
      .catch((e) => notify({ title: "Note", body: String(e?.message ?? e), level: "error" }))
      .then(() => { try { cx.notify(); } catch {} });
  }

  text() {
    const body = this.body.value();
    return body ? `${this.head.value()}\n${body}` : this.head.value();
  }

  async load() {
    this.saved = (await readTextFile(this.file)) ?? "";
    const nl = this.saved.indexOf("\n");
    this.head.set_value(nl < 0 ? this.saved : this.saved.slice(0, nl));
    this.body.set_value(nl < 0 ? "" : this.saved.slice(nl + 1));
    this.last = this.body.value();
    this.head.set_selected_range({ start: 0, end: 0 });
    this.body.set_selected_range({ start: 0, end: 0 });
    this.loaded = true;
    this.dirty = false;
    // A new note starts on its title; an old one where its text goes on.
    (this.saved.trim() ? this.body : this.head).focus();
  }

  async refresh() {
    if (this.dirty || !this.file) return;
    const now = await readTextFile(this.file);
    if (now === null || now === this.saved || this.dirty) return;
    const nl = now.indexOf("\n");
    this.saved = now;
    this.last = nl < 0 ? "" : now.slice(nl + 1); // not an Enter for continueList
    // set_value keeps the caret where it was (as far as the new text reaches).
    this.head.set_value(nl < 0 ? now : now.slice(0, nl));
    this.body.set_value(this.last);
    this.nameTab(now);
    setShared("notepad.live", { file: this.file, title: title(now) });
  }

  async flush() {
    if (!this.dirty || !this.file) return;
    const text = this.text();
    this.dirty = false;
    try {
      await writeTextFile(this.file, text, this.saved);
      this.saved = text;
      this.nameTab(text);
      // The list shows this title now, without waiting for the folder watch.
      setShared("notepad.live", { file: this.file, title: title(text) });
    } catch (e) {
      // Gone (deleted from the sidebar): nothing to keep. Changed elsewhere: say so.
      if ((await readTextFile(this.file)) !== null) notify({ title: "Note not saved", body: `${String(e?.message ?? e)}. Close and reopen the note to load its latest text.`, level: "error" });
    }
  }

  nameTab(text) {
    const name = title(text).slice(0, 40);
    if (this.tab && name !== this.named) { this.named = name; run("tab.rename", { id: this.tab, name }); }
  }

  // Keeps this copy in step with the sidebar: its tab, another note picked, a move, a rename.
  sync(cx) {
    // There is one note tab (the sidebar keeps it so), and this is it: follow its entry, not the
    // file this copy started with, which is stale after a reload or a restart.
    const [want, tab] = Object.entries(shared("notepad.tabs") ?? {})[0] ?? [];
    if (tab) this.tab = tab;
    // The tab shows the saved title (a no-op when it already does): covers a load before the tab was known.
    if (this.loaded && !this.target) this.nameTab(this.saved);
    if (want && want !== this.file && want !== this.target) {
      if (base(want) === base(this.file)) this.file = want; // moved to another folder: same note
      else {
        // Another note picked into this tab: save this one, then show that one.
        this.target = want;
        this.enqueue(cx, async () => {
          await this.leave();
          this.file = want;
          this.target = null;
          this.named = null;
          await this.load();
          this.nameTab(this.saved);
        });
      }
    }
    this.resolveLinks();
    const sent = shared("notepad.sent");
    if (sent?.file === this.file && this.loaded) {
      setShared("notepad.sent", null);
      this.markSent(sent);
    }
    const ask = shared("notepad.rename");
    if (ask?.file === this.file && this.loaded) {
      setShared("notepad.rename", null);
      this.head.set_value(ask.name);
      this.dirty = true;
      this.enqueue(cx, () => this.flush());
    }
  }

  // Puts the Claude mark after the sent text: where it was selected if it is still there, else
  // after its first match. A selection ending in line breaks gets the mark before them.
  markSent({ range, selection }) {
    const text = this.body.value();
    const sel = selection.replace(/\s+$/, "");
    if (!sel) return;
    let start = text.slice(range.start, range.start + sel.length) === sel ? range.start : text.indexOf(sel);
    if (start < 0) return;
    const end = start + sel.length;
    if (text.slice(end, end + MARK.length) === MARK) return;
    this.body.set_value(text.slice(0, end) + MARK + text.slice(end));
    this.last = this.body.value();
    this.dirty = true;
  }

  // A link's agent tab is the first tab that wasn't there when it was sent.
  resolveLinks() {
    const links = shared("notepad.links") ?? {};
    const mine = links[this.file];
    if (!mine?.some((l) => !l.tab)) return;
    const tabs = allTabs().map((t) => t.id);
    const taken = new Set(Object.values(links).flat().map((l) => l.tab).filter(Boolean));
    let changed = false;
    const next = mine.map((l) => {
      if (l.tab) return l;
      const tab = tabs.find((id) => !l.before.includes(id) && !taken.has(id));
      // Never showed up (the agent failed to start): drop it after a minute.
      if (!tab) { if (Date.now() - l.at > 60000) { changed = true; return null; } return l; }
      taken.add(tab); changed = true;
      return { id: l.id, snippet: l.snippet, tab, at: l.at };
    }).filter(Boolean);
    if (changed) setShared("notepad.links", { ...links, [this.file]: next });
  }

  unlink(id) {
    const links = shared("notepad.links") ?? {};
    setShared("notepad.links", { ...links, [this.file]: (links[this.file] ?? []).filter((l) => l.id !== id) });
  }

  // The agents this note started: what was sent, the agent's tab, and its status.
  linkBar(t) {
    const live = new Map(allTabs().map((tab) => [tab.id, tab]));
    const links = (shared("notepad.links") ?? {})[this.file] ?? [];
    if (!links.length) return null;
    const COLOR = { working: t.working, blocked: t.blocked, done: t.done, idle: t.idle };
    const WORD = { working: "working", blocked: "needs you", done: "done", idle: "idle" };
    return h_flex().id("note-links").w_full().flex_none().px(12).py(6).gap(6).flex_wrap().border_b(1).border_color(t.border).text_size(12)
      .children(links.map((l) => {
        const tab = l.tab ? live.get(l.tab) : null;
        const agent = tab ? agents().find((a) => a.tab === tab.id) : null;
        const status = agent?.status ?? null;
        const color = status ? COLOR[status] : t.dim;
        const label = !l.tab ? "starting…" : !tab ? "ended" : WORD[status] ?? "no agent";
        return h_flex().id(`link-${l.id}`).h(24).pl(8).pr(4).gap(6).items_center().rounded(6).max_w(360)
          .border_1().border_color(status === "working" ? color : t.border).bg(t.surface)
          .when(Boolean(tab), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`Show ${tab.name}`)
            .on_click(() => agent ? run("agent.focus", { terminal: agent.address }) : run("tab.select", { id: tab.id })))
          .child(status === "working"
            ? svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(color).spin(900)
            : div().flex_none().text_color(color).child("✻"))
          .child(div().min_w(0).truncate().text_color(t.foreground).child(l.snippet))
          .child(div().flex_none().text_color(t.dim).child(`→ ${tab?.name ?? "agent"}`))
          .child(div().flex_none().text_color(color).child(label))
          .child(div().id(`unlink-${l.id}`).flex_none().px(4).rounded(4).text_color(t.dim).cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Forget this link")
            .on_click((_e, cx) => { cx.stop_propagation(); this.unlink(l.id); }).child("×"));
      }));
  }

  // Leaving a note saves it. Empty notes stay: they are deleted only from the sidebar.
  async leave() { await this.flush(); }

  // Closing its tab (Delete, ⌘W) saves what's typed first.
  async close() { await this.leave(); }

  // The body's selection { start, end } (UTF-16, as JS strings index; start = end: the caret). The
  // state has no getter, but replace() puts text where the selection is: put a marker there, find it,
  // then put the text and the selection back as they were.
  range() {
    const M = "\uE000";
    const before = this.body.value();
    this.body.replace(M);
    const after = this.body.value();
    const start = after.indexOf(M);
    this.body.set_value(before);
    if (start < 0) return null;
    const end = start + before.length - (after.length - 1);
    this.body.set_selected_range({ start, end });
    return { start, end };
  }

  selection() {
    const r = this.range();
    return r ? this.body.value().slice(r.start, r.end) : "";
  }

  // Line styles are plain prefixes on the caret's line (the editor draws one style, so no bold or
  // headings): to-do ☐ / done ☑, bullet •, dash –, numbered 1., quote ▏, or none (body).
  setLine(pick) {
    const text = this.body.value();
    const r = this.range() ?? { start: text.length, end: text.length };
    const ls = text.lastIndexOf("\n", r.start - 1) + 1;
    const mark = text.slice(ls).match(/^(☐ |☑ |• |– |▏ |\d+\. )/)?.[0] ?? "";
    const prev = text.slice(text.lastIndexOf("\n", ls - 2) + 1, Math.max(ls - 1, 0)).match(/^(\d+)\. /);
    const swap = pick(mark, prev ? `${Number(prev[1]) + 1}. ` : "1. ");
    const d = swap.length - mark.length;
    this.body.set_value(text.slice(0, ls) + swap + text.slice(ls + mark.length));
    const start = Math.max(ls, r.start + d);
    this.body.set_selected_range({ start, end: Math.max(start, r.end + d) });
    this.body.focus();
    this.dirty = true;
  }

  // As Apple Notes' checklist button: a to-do, then done, then plain again.
  checklist() { this.setLine((m) => (m === "☐ " ? "☑ " : m === "☑ " ? "" : "☐ ")); }

  // The Aa menu: that style, or back to body if the line has it already.
  style(prefix) { this.setLine((m, number) => { const want = prefix === "1. " ? number : prefix; return m === want || (prefix === "1. " && /^\d+\. $/.test(m)) ? "" : want; }); }

  // Enter on a list line starts the next one (☐ after ☐ or ☑, 2. after 1., • after •); Enter on an
  // empty item ends the list, as in Apple Notes; "- text" + Enter turns into a to-do list. The textarea gives no keys, so: the text grew by one
  // "\n" right after a list line.
  continueList() {
    const now = this.body.value(), old = this.last ?? now;
    this.last = now;
    if (now.length !== old.length + 1) return;
    let p = 0;
    while (p < old.length && old[p] === now[p]) p++;
    if (now[p] !== "\n" || now.slice(p + 1) !== old.slice(p)) return;
    // Next to another "\n" the text alone can't say which one is new: the caret, just after it, can.
    if (p > 0 && now[p - 1] === "\n") {
      const r = this.range();
      if (!r || now[r.start - 1] !== "\n") return;
      p = r.start - 1;
    }
    const ls = now.lastIndexOf("\n", p - 1) + 1;
    const line = now.slice(ls, p);
    const m = line.match(/^(☐ |☑ |• |– |▏ |(\d+)\. )/);
    let out, caret;
    if (!m) {
      // "- something" + Enter: that line becomes a to-do, and so does the next ("- " and "☐ " are both 2 long).
      if (!/^- \S/.test(line)) return;
      out = `${now.slice(0, ls)}☐ ${line.slice(2)}\n☐ ${now.slice(p + 1)}`;
      caret = p + 3;
    } else if (line === m[0]) {
      out = now.slice(0, ls) + now.slice(p + 1);
      caret = ls;
    } else {
      const next = m[2] ? `${Number(m[2]) + 1}. ` : m[0] === "☑ " ? "☐ " : m[0];
      out = now.slice(0, p + 1) + next + now.slice(p + 1);
      caret = p + 1 + next.length;
    }
    this.last = out;
    this.body.set_value(out);
    this.body.set_selected_range({ start: caret, end: caret });
    this.dirty = true;
  }

  zoom(by) {
    const size = Math.min(28, Math.max(11, (shared("notepad.fontSize") ?? 15) + by));
    setShared("notepad.fontSize", size);
  }

  // Delete: save, move it to ~/Notes/.Trash (recoverable), close its tab.
  trash(cx) {
    const file = this.file;
    if (!file) return;
    this.enqueue(cx, async () => {
      await this.flush();
      const r = await exec("mv", ["-n", file, `${home()}/Notes/.Trash/`]);
      if (r.code !== 0) return notify({ title: "Couldn't delete note", body: r.stderr, level: "error" });
      if (this.tab) run("tab.close", { id: this.tab, confirmed: true });
    });
  }

  // A new tab running the most-picked installed agent, the note as its first message.
  runAgent(cx) {
    const text = this.text().split(MARK).join("").trim();
    if (!text) return notify({ title: "The note is empty", level: "warning" });
    cx.spawn(async () => {
      try {
        const agent = (await knownAgents()).filter((a) => a.installed).sort((a, b) => (b.key === "claude") - (a.key === "claude"))[0];
        if (!agent) return notify({ title: "No agent installed", level: "warning" });
        // Herdr passes the task as the agent's last argument: "- item" would read as an option, so end options first.
        const before = allTabs().map((t) => t.id);
        run("tab.new", { name: title(text).slice(0, 40), argv: text.startsWith("-") ? [...agent.run, "--"] : agent.run, task: text });
        const links = shared("notepad.links") ?? {};
        setShared("notepad.links", { ...links, [this.file]: [...(links[this.file] ?? []), { id: String(Date.now()), snippet: title(text).slice(0, 60), tab: null, before, at: Date.now() }] });
      } catch (e) {
        notify({ title: "Couldn't start agent", body: String(e?.message ?? e), level: "error" });
      }
    });
  }

  render(cx) {
    const t = theme();
    if (this.file) this.sync(cx);
    const made = Number(base(this.file)?.replace(/\.md$/, ""));
    const date = made ? stamp(new Date(made)) : "";
    if (!this.file) {
      return v_flex().size_full().bg(t.background).items_center().justify_center().text_color(t.dim)
        .child("Pick a note on the left, or make one with ✎.");
    }
    // .SystemUIFont is SF Pro on macOS, Apple Notes' font.
    const size = shared("notepad.fontSize") ?? 15;
    const tool = (id, icon, tip, action) => div().id(id).size(30).flex_none().flex().items_center().justify_center().rounded(7)
      .text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => { action(cx); cx.notify(); }).child(svg(icon).size(16));
    const gap = () => div().w(1).h(18).mx(6).bg(t.border);
    const styles = [["Body", ""], ["• Bulleted List", "• "], ["– Dashed List", "– "], ["1. Numbered List", "1. "], ["▏ Block Quote", "▏ "]];
    const menu = v_flex().id("aa-menu").absolute().top(40).left(80).w(200).p(4).rounded(9).border_1().border_color(t.border).bg(t.popover).text_size(13)
      .on_mouse_down_out((_e, cx) => { this.formatOpen = false; this.closedAt = Date.now(); cx.notify(); })
      .children(styles.map(([label, prefix], k) => div().id(`aa-${k}`).h(30).px(10).flex().items_center().rounded(6)
        .text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.formatOpen = false; this.style(prefix); cx.notify(); }).child(label)));
    return v_flex().size_full().min_h(0).bg(t.background).font_family(".SystemUIFont").relative()
      .child(h_flex().w_full().h(42).flex_none().px(12).gap(2).items_center().border_b(1).border_color(t.border)
        .child(tool("tb-new", "mods/workspace-chrome/square-pen.svg", "New note (Ctrl+N)", () => run("notepad.new")))
        .child(tool("tb-trash", "mods/notepad-note/trash.svg", "Delete note", (cx) => this.trash(cx)))
        .child(gap())
        .child(div().id("tb-aa").h(30).px(8).flex_none().flex().items_center().rounded(7).text_size(15).text_color(this.formatOpen ? t.foreground : t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Line style")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { this.formatOpen = !this.formatOpen && Date.now() - (this.closedAt ?? 0) > 300; cx.notify(); }).child("Aa"))
        .child(tool("tb-check", "mods/notepad-note/list-checks.svg", "Checklist", () => this.checklist()))
        .child(tool("tb-copy", "mods/notepad-note/copy.svg", "Copy note", (cx) => {
          cx.write_to_clipboard(this.text());
          notify({ title: "Note copied", level: "success", timeout: 1500 });
        }))
        .child(gap())
        .child(div().id("tb-smaller").h(30).px(8).flex_none().flex().items_center().rounded(7).text_size(12).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Smaller text")
          .on_click((_e, cx) => { this.zoom(-1); cx.notify(); }).child("A−"))
        .child(div().id("tb-bigger").h(30).px(8).flex_none().flex().items_center().rounded(7).text_size(16).text_color(t.muted)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Bigger text")
          .on_click((_e, cx) => { this.zoom(1); cx.notify(); }).child("A+"))
        .child(div().flex_1())
        .child(h_flex().id("run-agent").gap(6).px(10).h(28).items_center().rounded(7).text_size(12)
          .border_1().border_color(t.border).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Start an agent with this note")
          .on_click((_e, cx) => this.runAgent(cx))
          .child(svg("mods/workspace-chrome/terminal.svg").size(12)).child("Run agent")))
      .child(this.linkBar(t) ?? div())
      .child(v_flex().flex_1().min_h(0).w_full().px(40).pt(14).pb(12).gap(10)
      .child(div().w_full().flex().justify_center().text_size(12).text_color(t.dim).child(date))
      .child(Input.new(this.head).w_full().h(Math.round(size * 2.6)).font_family(".SystemUIFont").text_size(Math.round(size * 1.73)).font_bold().text_color(t.foreground))
      .child(div().flex_1().min_h(0).w_full().flex().flex_col().relative()
        .child(Textarea.new(this.body).flex_1().min_h(0).w_full().font_family(".SystemUIFont").text_size(size).line_height(1.35).text_color(t.foreground))
        // Drawn over the body so it gets right presses first: stopping them keeps the selection.
        // Left presses carry on to the textarea underneath.
        .child(div().id("note-right-click").absolute().inset(0)
          .on_mouse_down("right", (e, cx) => {
            cx.stop_propagation();
            // A window, not a popup: it leaves the keyboard with the body, and the body only draws
            // its selection while it has the keyboard. note-menu closes itself on a press outside.
            openOverlay({ mod: "notepad-menu", kind: "window", at: { x: e.position.x, y: e.position.y }, width: 240, height: 76,
              props: { file: this.file, range: this.range(), selection: this.selection() } });
          }))))
      .when(Boolean(this.formatOpen), (el) => el.child(menu));
  }
}
