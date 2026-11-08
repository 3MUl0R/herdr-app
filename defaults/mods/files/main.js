// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window } from "herdr";
import { createEntry, validateNewName, windowsPath } from "./create.js";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.original = null; this.editing = false; this.dirty = false; this.saving = false;
    this.pendingOpen = undefined; this.notice = null; this.creating = null; this.createError = null;
    this.createInput = InputState.new({ placeholder: "File or folder name" });
    this.createInput.on("change", (_event, cx) => { this.createError = null; cx.notify(); });
    this.createInput.on("submit", (_event, cx) => this.submitCreate(cx));
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) {
        const draft = this.editing && this.dirty && this.file && this.code
          ? { file: this.file, text: this.code.value(), original: this.original } : null;
        this.saved.set(this.context.key, { folders: this.folders, file: this.file, draft });
      }
      const saved = this.saved.get(next);
      this.editing = false; this.dirty = false; this.pendingOpen = undefined;
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx, saved.draft);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }


  makeEditor(path, text, readonly) {
    this.code?.release();
    const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
    const state = EditorState.new({
      language: LANG[ext] ?? ext, readonly, value: text,
      font_family: settings().font_family, font_size: 12,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 },
    });
    this.code = state;
    if (!readonly) state.on("change", (_event, cx) => {
      if (this.code !== state) return;
      this.dirty = state.value() !== this.original;
      cx.notify();
    });
  }

  show(path, cx, draft = null, editAfter = false) {
    if (this.file === path && this.code && !draft) return;
    if (this.editing && this.dirty && !draft) {
      this.pendingOpen = path;
      this.notice = "You have unsaved changes. Save or discard them before leaving this file.";
      cx?.notify();
      return;
    }
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    this.original = null; this.editing = false; this.dirty = false;
    this.pendingOpen = undefined; this.notice = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        this.original = text;
        if (text.length > 400000) {
          this.makeEditor(path, text.slice(0, 400000) + "\n… (file truncated)", true);
          this.notice = "Large file preview only: editing is disabled.";
          return;
        }
        this.makeEditor(path, text, true);
        if (draft?.file === path) {
          this.original = draft.original;
          this.enterEdit(cx, draft.text);
          if (text !== draft.original) this.notice = "File changed outside Herdr; saving this draft will require resolving the conflict.";
        } else if (editAfter) this.enterEdit(cx);
      } catch (e) {
        if (this.file === path && this.current(context)) this.fileError = String(e?.message ?? e);
      } finally { cx.notify(); }
    });
  }

  enterEdit(cx, text = this.original) {
    if (!this.file || this.original === null || !this.code || this.saving) return;
    if (this.code.value().length > 400000) return;
    this.makeEditor(this.file, text, false);
    if (this.code.value() !== text) {
      this.makeEditor(this.file, this.original, true);
      this.notice = "The editor changed the file's text; editing is disabled to avoid corrupting it.";
      cx.notify();
      return;
    }
    this.editing = true; this.dirty = text !== this.original; this.notice = null; cx.notify();
  }

  cancelEdit(cx) {
    if (this.dirty) {
      this.pendingOpen = this.file;
      this.notice = "Discard unsaved changes?";
    } else {
      this.editing = false;
      this.makeEditor(this.file, this.original, true);
      this.notice = null;
    }
    cx.notify();
  }

  discardAndOpen(cx) {
    const next = this.pendingOpen;
    this.dirty = false; this.editing = false; this.pendingOpen = undefined;
    this.show(next === undefined ? this.file : next, cx);
    cx.notify();
  }

  save(cx) {
    if (!this.editing || !this.file || this.saving || !this.code) return;
    const text = this.code.value(), context = this.context, file = this.file;
    const original = this.original, on = this.on, path = `${this.root}/${file}`;
    if (text.length > 1024 * 1024) {
      this.notice = "Text file exceeds the 1 MiB editor limit; save a smaller file.";
      cx.notify();
      return;
    }
    if (text === original) {
      this.editing = false;
      this.makeEditor(file, text, true);
      this.notice = null; cx.notify();
      return;
    }
    this.saving = true; this.notice = null; cx.notify();
    cx.spawn(async cx => {
      try {
        await writeTextFile(path, text, original, { on });
        if (this.file !== file || !this.current(context)) return;
        this.original = text; this.dirty = false; this.editing = false;
        const next = this.pendingOpen;
        this.pendingOpen = undefined;
        if (next !== undefined && next !== file) this.show(next, cx);
        else { this.makeEditor(file, text, true); this.refresh(cx); }
      } catch (e) {
        if (this.file === file && this.current(context)) this.notice = String(e?.message ?? e);
      } finally { this.saving = false; cx.notify(); }
    });
  }

  startCreate(kind, folder, cx) {
    if (!this.root || this.saving) return;
    this.creating = { kind, folder, busy: false };
    this.createError = null; this.createInput.set_value("");
    this.createInput.focus(); cx.notify();
  }

  submitCreate(cx) {
    const creating = this.creating;
    if (!creating || creating.busy) return;
    const name = this.createInput.value(), context = this.context, on = this.on;
    const parent = creating.folder ? `${this.root}/${creating.folder}` : this.root;
    const windows = windowsPath(parent) || (!on && window()?.platform === "windows");
    const problem = validateNewName(name, windows);
    if (problem) { this.createError = problem; cx.notify(); return; }
    creating.busy = true; this.createError = null; cx.notify();
    cx.spawn(async cx => {
      try {
        await createEntry({ exec, on, parent, name, kind: creating.kind, windows });
        if (!this.current(context)) return;
        const relative = creating.folder ? `${creating.folder}/${name}` : name;
        this.creating = null; this.createError = null;
        if (creating.kind === "folder") this.folders.add(relative);
        this.refresh(cx);
        if (creating.kind === "file") this.show(relative, cx, null, true);
      } catch (e) {
        if (this.creating === creating && this.current(context)) this.createError = String(e?.message ?? e);
      } finally { creating.busy = false; cx.notify(); }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      const row = h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name));
      if (entry.dir) row.child(div().id(`add-${path}`).px(6).cursor_pointer().text_color(t.dim)
        .on_click((_e, cx) => { cx.stop_propagation(); this.startCreate("file", path, cx); }).child("+"));
      if (mark) row.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark));
      out.push(row);
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (key() !== this.context?.key) this.refresh(cx);
    const t = theme();
    const button = (id, label, action) => div().id(id).h(28).px(8).rounded(6).cursor_pointer()
      .hover(s => s.bg(t.hover)).on_click(action).child(label);
    const panel = v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13);
    const header = h_flex().h(42).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border);
    if (this.file) header.child(button("files-back", "←", (_e, cx) => this.show(null, cx)));
    header.child(div().font_semibold().child(this.dirty ? "Files ●" : "Files"));
    header.child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim)
      .child(this.file ?? this.root?.split(/[\\\\/]/).pop() ?? ""));
    if (!this.file) {
      header.child(button("files-create-file", "+ File", (_e, cx) => this.startCreate("file", "", cx)));
      header.child(button("files-create-folder", "+ Folder", (_e, cx) => this.startCreate("folder", "", cx)));
    } else if (this.editing) {
      header.child(button("files-cancel-edit", "Cancel", (_e, cx) => this.cancelEdit(cx)));
      header.child(button("files-save", this.saving ? "Saving…" : "Save", (_e, cx) => this.save(cx)));
    } else if (this.code && this.original !== null && this.code.value().length <= 400000) {
      header.child(button("files-edit", "Edit", (_e, cx) => this.enterEdit(cx)));
    }
    panel.child(header);
    if (this.creating && !this.file) {
      const bar = h_flex().h(40).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border);
      bar.child(button("files-create-kind", this.creating.kind === "file" ? "File ▾" : "Folder ▾",
        (_e, cx) => { this.creating.kind = this.creating.kind === "file" ? "folder" : "file"; cx.notify(); }));
      bar.child(Input.new(this.createInput).flex_1().min_w(0).h(30).px(7).rounded(6).border_1().border_color(t.input).bg(t.background).text_color(t.foreground));
      bar.child(button("files-create-confirm", this.creating.busy ? "Creating…" : "Create", (_e, cx) => this.submitCreate(cx)));
      bar.child(button("files-create-cancel", "×", (_e, cx) => { this.creating = null; this.createError = null; cx.notify(); }));
      panel.child(bar);
      if (this.createError) panel.child(div().px(10).py(4).text_color(t.blocked).text_size(12).child(this.createError));
      if (this.creating.folder) panel.child(div().px(10).py(2).text_color(t.dim).text_size(11)
        .child(`In ${this.creating.folder}`));
    }
    if (this.notice) panel.child(div().px(10).py(6).text_color(t.blocked).text_size(12).child(this.notice));
    if (this.pendingOpen !== undefined && this.editing && this.dirty) {
      panel.child(h_flex().px(10).py(5).gap(6).items_center()
        .child(button("files-save-before-leave", "Save", (_e, cx) => this.save(cx)))
        .child(button("files-discard", "Discard", (_e, cx) => this.discardAndOpen(cx)))
        .child(button("files-keep-editing", "Keep editing", (_e, cx) => { this.pendingOpen = undefined; this.notice = null; cx.notify(); })));
    }
    if (!this.file) {
      const tree = v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t));
      if (this.error || !this.entries.get("")?.length) tree.child(div().p(8).text_size(12).text_color(t.dim)
        .child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder")));
      if (this.limited) tree.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"));
      panel.child(tree);
    } else {
      panel.child(this.code ? Editor.new(this.code).flex_1().min_h(0)
        : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…"));
    }
    return panel;
  }

}
