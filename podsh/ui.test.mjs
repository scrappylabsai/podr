// node --test podsh/ui.test.mjs
//
// The composer's cursor arithmetic is the part that silently corrupts a pane
// when it drifts (wrong row count => the erase eats scrollback), so the width,
// wrap and cursor-mapping primitives are pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { visWidth, wrap, truncVis, padVis, KeyDecoder, LineEditor } from "./ui.mjs";

test("visWidth ignores ANSI and counts wide glyphs as two columns", () => {
  assert.equal(visWidth("\x1b[31mred\x1b[0m"), 3);
  assert.equal(visWidth("你好ab"), 6);
  assert.equal(visWidth(""), 0);
});

test("wrap never exceeds the width and never loses text", () => {
  const s = "the quick brown fox jumps over the lazy dog";
  for (const w of [4, 7, 12, 40]) {
    const lines = wrap(s, w);
    for (const l of lines) assert.ok(visWidth(l) <= w, `"${l}" > ${w}`);
    // every character survives; below the longest word, breaking mid-word is
    // the only option, so only the wide cases keep their word boundaries.
    assert.equal(lines.join("").replace(/ /g, ""), s.replace(/ /g, ""));
    if (w >= 12) assert.equal(lines.join(" ").replace(/\s+/g, " ").trim(), s);
  }
  assert.ok(wrap("\x1b[31mred text here\x1b[0m", 6).every((l) => visWidth(l) <= 6));
});

test("truncVis / padVis land on exact columns", () => {
  assert.ok(truncVis("abcdefgh", 5).includes("…"));
  assert.equal(visWidth(padVis("ab", 6)), 6);
  assert.equal(padVis("abcdef", 3), "abcdef"); // never truncates
});

test("decoder handles chords, split sequences and bracketed paste", () => {
  const d = new KeyDecoder();
  assert.deepEqual(d.push("ab").map((k) => k.text), ["a", "b"]);
  assert.equal(d.push("\x1b[A")[0].name, "up");
  assert.equal(d.push("\x1b[3~")[0].name, "delete");
  assert.equal(d.push("\x1b[1;5D")[0].ctrl, true);
  assert.deepEqual(d.push("\x01")[0], { name: "a", ctrl: true });
  // an escape sequence split across two reads must not surface as a lone ESC
  assert.equal(d.push("\x1b").length, 0);
  assert.equal(d.push("[B")[0].name, "down");
  d.push("\x1b");
  assert.equal(d.flushEscape().name, "escape");
  // a paste is data, not keys — even when it straddles chunks
  d.push("\x1b[200~hel");
  assert.deepEqual(d.push("lo\nthere\x1b[201~")[0], { name: "paste", text: "hello\nthere" });
});

test("editor: readline keys, history, backslash continuation", () => {
  const e = new LineEditor({});
  for (const c of "hello world") e.handle({ name: "char", text: c });
  e.handle({ name: "w", ctrl: true });
  assert.equal(e.value(), "hello ");
  e.handle({ name: "a", ctrl: true });
  assert.equal(e.cur, 0);
  e.handle({ name: "e", ctrl: true });
  assert.equal(e.cur, 6);
  assert.equal(e.handle({ name: "enter" }), "submit");

  const b = new LineEditor({});
  for (const c of "one\\") b.handle({ name: "char", text: c });
  assert.equal(b.handle({ name: "enter" }), null, "trailing backslash continues the line");
  assert.equal(b.value(), "one\n");

  const h = new LineEditor({ history: ["first", "second"] });
  h.browse(-1); assert.equal(h.value(), "second");
  h.browse(-1); assert.equal(h.value(), "first");
  h.browse(1); h.browse(1); assert.equal(h.value(), "", "walking forward restores the draft");
});

test("editor: cursor row/col survive wrapping and newlines", () => {
  const e = new LineEditor({});
  e.insert("x".repeat(25));
  const r = e.render(10, "> ", "  ");
  assert.equal(r.lines.length, 4);
  assert.ok(r.lines.every((l) => visWidth(l) <= 10));
  assert.deepEqual(r.cursor, { row: 3, col: 3 });

  const m = new LineEditor({});
  m.insert("ab\ncd");
  const r2 = m.render(20, "> ", "  ");
  assert.equal(r2.lines.length, 2);
  assert.deepEqual(r2.cursor, { row: 1, col: 4 });
});
