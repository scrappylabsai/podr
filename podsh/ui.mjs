// ui.mjs — bottom-anchored composer region for `podsh attach`.
//
// dsh's own client is React, so the terminal face started life as a scrolling
// log with modal hotkeys (press `i` to get a prompt). This module gives it the
// shape people already know from Claude Code / Kimi: an always-live input box
// pinned to the bottom of the pane, transcript scrolling above it.
//
// The mechanism is ordinary. Everything at the bottom is a REGION we own: to
// print a transcript line we erase the region, write the line (it scrolls into
// scrollback like any other output), then draw the region again. Every line we
// draw is hard-wrapped to the terminal width ourselves, so the row count is
// exact and the cursor arithmetic never drifts.
//
// Zero dependencies on purpose — podr ships this to people who pinned dsh.

const ANSI_G = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
export const stripAnsi = (s) => String(s).replace(ANSI_G, "");

// Enough of wcwidth to keep CJK and emoji from shearing the box.
function charWidth(cp) {
  if (cp === 0x200d) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

export function visWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(String(s))) w += charWidth(ch.codePointAt(0));
  return w;
}

export function truncVis(s, width) {
  if (visWidth(s) <= width) return s;
  let out = "", w = 0;
  const src = String(s);
  for (let i = 0; i < src.length; ) {
    if (src[i] === "\x1b") {
      const m = src.slice(i).match(/^\x1b\[[0-9;?]*[ -\/]*[@-~]/);
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > width - 1) break;
    out += ch; w += cw; i += ch.length;
  }
  return out + "\x1b[0m…";
}

export function padVis(s, width) {
  const pad = width - visWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

// Word-preferring wrap that steps over ANSI without counting it.
export function wrap(s, width) {
  const src = String(s);
  if (width < 2) return [src];
  const lines = [];
  let line = "", w = 0, lastSpace = -1;
  for (let i = 0; i < src.length; ) {
    if (src[i] === "\x1b") {
      const m = src.slice(i).match(/^\x1b\[[0-9;?]*[ -\/]*[@-~]/);
      if (m) { line += m[0]; i += m[0].length; continue; }
    }
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > width) {
      if (lastSpace > 0) {
        lines.push(line.slice(0, lastSpace));
        line = line.slice(lastSpace + 1);
      } else {
        lines.push(line);
        line = "";
      }
      w = visWidth(line);
      lastSpace = -1;
    }
    if (ch === " ") lastSpace = line.length;
    line += ch; w += cw; i += ch.length;
  }
  lines.push(line);
  return lines;
}

// ---------- key decoding ----------
// Raw-mode stdin arrives as bytes: escape sequences can straddle chunks and a
// bracketed paste can carry anything, so decoding is a small state machine
// rather than a switch over single characters.
const CSI_FINAL = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end",
};
const CSI_TILDE = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end" };

export class KeyDecoder {
  constructor() { this.buf = ""; this.paste = null; }

  // Returns decoded keys; leaves an incomplete tail in the buffer.
  push(chunk) {
    this.buf += chunk;
    const keys = [];
    for (;;) {
      if (this.paste !== null) {
        const end = this.buf.indexOf("\x1b[201~");
        if (end === -1) { this.paste += this.buf; this.buf = ""; break; }
        this.paste += this.buf.slice(0, end);
        this.buf = this.buf.slice(end + 6);
        keys.push({ name: "paste", text: this.paste });
        this.paste = null;
        continue;
      }
      if (!this.buf.length) break;
      if (this.buf.startsWith("\x1b[200~")) { this.paste = ""; this.buf = this.buf.slice(6); continue; }
      const k = this.take();
      if (!k) break;              // incomplete escape sequence — wait for more
      if (k !== true) keys.push(k); // true = consumed-and-ignored
    }
    return keys;
  }

  // A lone ESC is indistinguishable from the start of a sequence until the next
  // byte fails to arrive; the caller flushes on a short timer.
  pendingEscape() { return this.paste === null && this.buf.startsWith("\x1b"); }
  flushEscape() {
    if (!this.pendingEscape()) return null;
    const lone = this.buf === "\x1b";
    this.buf = "";
    return lone ? { name: "escape" } : null;
  }

  take() {
    const b = this.buf;
    if (b[0] !== "\x1b") {
      const cp = b.codePointAt(0);
      const ch = String.fromCodePoint(cp);
      this.buf = b.slice(ch.length);
      if (ch === "\r" || ch === "\n") return { name: "enter" };
      if (ch === "\t") return { name: "tab" };
      if (ch === "\x7f" || ch === "\b") return { name: "backspace" };
      if (cp < 32) return { name: String.fromCharCode(cp + 96), ctrl: true };
      return { name: "char", text: ch };
    }
    if (b.length === 1) return null;
    if (b[1] === "[" || b[1] === "O") {
      const m = b.match(/^\x1b[[O]([0-9;]*)([A-Za-z~])/);
      if (!m) return b.length > 12 ? (this.buf = b.slice(1), true) : null;
      this.buf = b.slice(m[0].length);
      const params = m[1].split(";");
      const mod = parseInt(params[1] ?? "1", 10) - 1;   // 1=shift 2=alt 4=ctrl
      const key = { ctrl: !!(mod & 4), meta: !!(mod & 2), shift: !!(mod & 1) };
      if (m[2] === "~") {
        if (params[0] === "13") return { ...key, name: "enter" };   // kitty shift+enter
        return { ...key, name: CSI_TILDE[params[0]] ?? "unknown" };
      }
      if (m[2] === "u" && params[0] === "13") return { ...key, name: "enter" };
      return { ...key, name: CSI_FINAL[m[2]] ?? "unknown" };
    }
    // ESC-prefixed: alt+<key>
    const cp = b.codePointAt(1);
    const ch = String.fromCodePoint(cp);
    this.buf = b.slice(1 + ch.length);
    if (ch === "\r" || ch === "\n") return { name: "enter", meta: true };
    if (ch === "\x7f" || ch === "\b") return { name: "backspace", meta: true };
    return { name: ch, meta: true };
  }
}

// ---------- the editable line ----------
const WORD = /[\p{L}\p{N}_]/u;

export class LineEditor {
  constructor({ history = [], onSubmit } = {}) {
    this.text = "";
    this.cur = 0;
    this.history = history.slice(-500);
    this.hi = null;      // index into history while browsing
    this.draft = "";     // what was typed before browsing started
    this.onSubmit = onSubmit;
  }

  value() { return this.text; }
  clear() { this.text = ""; this.cur = 0; this.hi = null; }

  insert(s) {
    this.text = this.text.slice(0, this.cur) + s + this.text.slice(this.cur);
    this.cur += s.length;
    this.hi = null;
  }

  remember(line) {
    if (!line.trim()) return;
    if (this.history[this.history.length - 1] !== line) this.history.push(line);
    if (this.history.length > 500) this.history.shift();
  }

  wordStart() {
    let i = this.cur;
    while (i > 0 && !WORD.test(this.text[i - 1])) i--;
    while (i > 0 && WORD.test(this.text[i - 1])) i--;
    return i;
  }
  wordEnd() {
    let i = this.cur;
    while (i < this.text.length && !WORD.test(this.text[i])) i++;
    while (i < this.text.length && WORD.test(this.text[i])) i++;
    return i;
  }
  lineStart() { const i = this.text.lastIndexOf("\n", this.cur - 1); return i === -1 ? 0 : i + 1; }
  lineEnd() { const i = this.text.indexOf("\n", this.cur); return i === -1 ? this.text.length : i; }

  browse(dir) {
    if (!this.history.length) return;
    if (this.hi === null) {
      if (dir > 0) return;
      this.draft = this.text;
      this.hi = this.history.length;
    }
    const next = this.hi + dir;
    if (next >= this.history.length) { this.hi = null; this.text = this.draft; this.cur = this.text.length; return; }
    if (next < 0) return;
    this.hi = next;
    this.text = this.history[next];
    this.cur = this.text.length;
  }

  // Returns an action for the caller, or null when the key was consumed here.
  handle(key) {
    const k = key.name;
    if (key.name === "paste") { this.insert(key.text.replace(/\r\n?/g, "\n")); return null; }

    if (k === "enter") {
      // Multi-line the way every shell already taught: trailing backslash, or
      // an explicit alt/shift+enter for people whose terminal sends it.
      if (key.meta || key.shift) { this.insert("\n"); return null; }
      if (this.text.endsWith("\\")) { this.text = this.text.slice(0, -1); this.cur = Math.max(0, this.cur - 1); this.insert("\n"); return null; }
      return "submit";
    }
    if (k === "j" && key.ctrl) { this.insert("\n"); return null; }
    if (k === "escape") return "escape";
    if (k === "c" && key.ctrl) return "interrupt";
    if (k === "d" && key.ctrl) return this.text.length ? null : "eof";
    if (k === "l" && key.ctrl) return "clear-screen";

    if (k === "char") { this.insert(key.text); return null; }
    if (k === "tab") { this.insert("  "); return null; }

    if (k === "backspace") {
      if (key.meta || key.ctrl) { const s = this.wordStart(); this.text = this.text.slice(0, s) + this.text.slice(this.cur); this.cur = s; return null; }
      if (this.cur > 0) { this.text = this.text.slice(0, this.cur - 1) + this.text.slice(this.cur); this.cur--; }
      return null;
    }
    if (k === "delete") { this.text = this.text.slice(0, this.cur) + this.text.slice(this.cur + 1); return null; }
    if (k === "w" && key.ctrl) { const s = this.wordStart(); this.text = this.text.slice(0, s) + this.text.slice(this.cur); this.cur = s; return null; }
    if (k === "u" && key.ctrl) { const s = this.lineStart(); this.text = this.text.slice(0, s) + this.text.slice(this.cur); this.cur = s; return null; }
    if (k === "k" && key.ctrl) { this.text = this.text.slice(0, this.cur) + this.text.slice(this.lineEnd()); return null; }

    if (k === "left") { this.cur = key.ctrl || key.meta ? this.wordStart() : Math.max(0, this.cur - 1); return null; }
    if (k === "right") { this.cur = key.ctrl || key.meta ? this.wordEnd() : Math.min(this.text.length, this.cur + 1); return null; }
    if (k === "b" && key.meta) { this.cur = this.wordStart(); return null; }
    if (k === "f" && key.meta) { this.cur = this.wordEnd(); return null; }
    if (k === "a" && key.ctrl) { this.cur = this.lineStart(); return null; }
    if (k === "e" && key.ctrl) { this.cur = this.lineEnd(); return null; }
    if (k === "home") { this.cur = 0; return null; }
    if (k === "end") { this.cur = this.text.length; return null; }

    if (k === "up" || (k === "p" && key.ctrl)) { this.browse(-1); return null; }
    if (k === "down" || (k === "n" && key.ctrl)) { this.browse(1); return null; }
    return null;
  }

  // Hard-wrapped so the cursor row/col are exact rather than inferred.
  render(innerWidth, prompt, cont) {
    const pw = visWidth(prompt), cw = visWidth(cont);
    const logical = this.text.split("\n");
    const lines = [];
    let cursor = null;
    let seen = 0;
    for (let li = 0; li < logical.length; li++) {
      const body = logical[li];
      const pre = li === 0 ? prompt : cont;
      const avail = Math.max(1, innerWidth - (li === 0 ? pw : cw));
      const chunks = [];
      let acc = "", w = 0;
      for (const ch of body) {
        const c = charWidth(ch.codePointAt(0));
        if (w + c > avail) { chunks.push(acc); acc = ""; w = 0; }
        acc += ch; w += c;
      }
      chunks.push(acc);
      // cursor inside this logical line?
      if (cursor === null && this.cur >= seen && this.cur <= seen + body.length) {
        const col = this.cur - seen;
        let rest = col, row = 0;
        for (let ci = 0; ci < chunks.length; ci++) {
          if (rest <= chunks[ci].length) { row = ci; break; }
          rest -= chunks[ci].length;
          row = ci + 1;
        }
        const preW = li === 0 ? pw : cw;
        cursor = { row: lines.length + Math.min(row, chunks.length - 1), col: preW + visWidth(chunks[Math.min(row, chunks.length - 1)].slice(0, rest)) };
      }
      chunks.forEach((c, ci) => lines.push((ci === 0 ? pre : cont) + c));
      seen += body.length + 1;
    }
    return { lines, cursor: cursor ?? { row: 0, col: pw } };
  }
}

// ---------- the region ----------
export class Region {
  constructor({ stream = process.stdout, maxLive = 8 } = {}) {
    this.stream = stream;
    this.maxLive = maxLive;
    this.active = false;
    this.builder = () => ({ lines: [] });
    this.partial = "";     // streamed text with no newline yet
    this.pending = "";     // committed transcript waiting for the next flush
    this.rows = 0;         // rows the region occupies right now
    this.crow = 0;         // cursor row within the region
    this.timer = null;
  }

  get cols() { return Math.max(20, this.stream.columns || 80); }
  get termRows() { return Math.max(6, this.stream.rows || 24); }

  start(builder) {
    this.builder = builder;
    this.active = true;
    this.stream.write("\x1b[?2004h"); // bracketed paste: pasted text is data, not keys
    this.schedule();
  }

  stop() {
    if (!this.active) return;
    this.flushPartial();
    const tail = this.pending;
    this.pending = "";
    this.stream.write(this.eraseSeq() + tail + "\x1b[?25h\x1b[?2004l");
    this.rows = 0;
    this.active = false;
  }

  // Transcript output. Complete lines go to scrollback; a trailing fragment is
  // shown live above the box until it finishes (this is how streamed assistant
  // text stays visible without fighting the region for the cursor).
  write(text) {
    if (!this.active) { this.stream.write(text); return; }
    this.partial += text;
    const cut = this.partial.lastIndexOf("\n");
    if (cut !== -1) {
      this.pending += this.partial.slice(0, cut + 1);
      this.partial = this.partial.slice(cut + 1);
    }
    this.schedule();
  }

  flushPartial() {
    if (this.partial) { this.pending += this.partial + "\n"; this.partial = ""; }
  }

  clearScreen() {
    this.rows = 0;
    this.stream.write("\x1b[2J\x1b[H");
    this.schedule();
  }

  schedule() {
    if (!this.active || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.render(); }, 16);
  }

  render() {
    if (!this.active) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const cols = this.cols;
    const built = this.builder(cols) ?? { lines: [] };
    const live = this.partial ? wrap(this.partial, cols) : [];
    const body = [...live.slice(-this.maxLive), ...built.lines];
    const cap = this.termRows - 1;
    const trimmed = body.length > cap ? body.slice(body.length - cap) : body;
    const drop = body.length - trimmed.length;
    const cursor = built.cursor
      ? { row: Math.min(trimmed.length - 1, built.cursor.row + Math.min(live.length, this.maxLive) - drop), col: built.cursor.col }
      : null;

    let s = "\x1b[?25l" + this.eraseSeq();
    s += this.pending;
    this.pending = "";
    s += trimmed.join("\n");
    this.rows = trimmed.length;
    this.crow = this.rows - 1;
    if (cursor && cursor.row >= 0) {
      const up = this.rows - 1 - cursor.row;
      if (up > 0) s += `\x1b[${up}A`;
      s += "\r";
      if (cursor.col > 0) s += `\x1b[${cursor.col}C`;
      this.crow = cursor.row;
      s += "\x1b[?25h";
    }
    this.stream.write(s);
  }

  // Park the cursor at the top of the region and wipe everything below it.
  eraseSeq() {
    if (!this.rows) return "";
    let s = "";
    const down = this.rows - 1 - this.crow;
    if (down > 0) s += `\x1b[${down}B`;
    s += "\r";
    if (this.rows > 1) s += `\x1b[${this.rows - 1}A`;
    return s + "\x1b[J";
  }
}

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
