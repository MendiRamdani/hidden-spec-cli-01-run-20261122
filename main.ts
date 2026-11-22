// mend: one patch tool for every AI edit format (SPEC.md v1).
// Node 22, standard library only. Run as: node main.ts [options] [PATCH]
// When MAKEFUN_ENV_URL is set, hand the trial over to runner.ts.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// When MAKEFUN_ENV_URL is set, hand the trial over to runner.ts.
// (The actual invocation lives at the bottom of this file, after every
// definition, so no class is used before it is initialized.)

class ParseErr extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

interface FileState {
  lines: string[];
  eol: '\r\n' | '\n';
  endsWithBreak: boolean;
}

function rstrip(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function strip(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function isSafe(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], eol: '\n', endsWithBreak: false };
  const firstNl = text.indexOf('\n');
  const eol: '\r\n' | '\n' = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(eol);
  let endsWithBreak = false;
  if (parts[parts.length - 1] === '') {
    endsWithBreak = true;
    parts.pop();
  }
  return { lines: parts, eol, endsWithBreak };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.eol) + (f.endsWithBreak ? f.eol : '');
}

// The tree, kept in memory until every edit has succeeded.
class Tree {
  private origCache = new Map<string, string | null>();
  private cur = new Map<string, string | null>();

  orig(path: string): string | null {
    if (!this.origCache.has(path)) {
      let v: string | null = null;
      try {
        if (existsSync(path)) {
          const st = statSync(path);
          if (st.isFile()) v = readFileSync(path, 'utf8');
        }
      } catch {
        v = null;
      }
      this.origCache.set(path, v);
    }
    return this.origCache.get(path) as string | null;
  }

  exists(path: string): boolean {
    if (this.cur.has(path)) return this.cur.get(path) !== null;
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  }

  get(path: string): string | null {
    if (this.cur.has(path)) return this.cur.get(path) as string | null;
    return this.orig(path);
  }

  set(path: string, content: string | null): void {
    this.cur.set(path, content);
  }

  touched(): string[] {
    return [...this.cur.keys()];
  }
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return strip(a) === strip(b);
}

function findOccurrences(lines: string[], pat: string[], tier: number, start = 0): number[] {
  const out: number[] = [];
  if (pat.length === 0 || pat.length > lines.length) return out;
  for (let i = start; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (!lineEq(lines[i + j], pat[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTierMax(lines: string[], pat: string[], maxTier: number, start = 0): { tier: number; occ: number[] } | null {
  for (let t = 0; t <= maxTier; t++) {
    const occ = findOccurrences(lines, pat, t, start);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noNl: boolean;
}

// Build the N lines of a hunk/chunk: context lines come from the file
// itself, other lines are the patch's (re-indented at tier 2).
function buildReplacement(items: BodyItem[], fileLines: string[], pos: number, tier: number): string[] {
  const oLines = items.filter((i) => i.kind === 'ctx' || i.kind === 'old').map((i) => i.text);
  const out: string[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[pos + oIdx]);
      oIdx++;
    } else if (it.kind === 'old') {
      oIdx++;
    } else {
      let ln = it.text;
      if (tier === 2 && oLines.length > 0) {
        const p = leadingOf(oLines[0]);
        const f = leadingOf(fileLines[pos]);
        if (ln !== '' && !/^[ \t]+$/.test(ln) && ln.startsWith(p)) ln = f + ln.slice(p.length);
      }
      out.push(ln);
    }
  }
  return out;
}

function lastNNoNl(items: BodyItem[]): boolean {
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k].kind === 'ctx' || items[k].kind === 'new') return items[k].noNl;
  }
  return false;
}

interface Hunk {
  a: number;
  items: BodyItem[];
}

// Apply unified hunks in order to a file state. Returns a failure code or null.
function applyHunks(f: FileState, hunks: Hunk[], strict: boolean): string | null {
  const maxTier = strict ? 0 : 2;
  let d = 0;
  for (const h of hunks) {
    const oLines = h.items.filter((i) => i.kind === 'ctx' || i.kind === 'old').map((i) => i.text);
    if (oLines.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const repl = buildReplacement(h.items, f.lines, pos, 0);
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...repl);
      if (atEnd && repl.length > 0) f.endsWithBreak = !lastNNoNl(h.items);
      d += repl.length;
    } else {
      const found = findTierMax(f.lines, oLines, maxTier);
      if (!found) return 'no-match';
      const target = h.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const repl = buildReplacement(h.items, f.lines, best, found.tier);
      const runsToEnd = best + oLines.length === f.lines.length;
      f.lines.splice(best, oLines.length, ...repl);
      if (runsToEnd && repl.length > 0) f.endsWithBreak = !lastNNoNl(h.items);
      d += repl.length - oLines.length;
    }
  }
  return null;
}

function splitPatchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function detectFormat(lines: string[]): string | null {
  const firstNonBlank = lines.find((l) => l.trim() !== '');
  if (firstNonBlank !== undefined) {
    if (firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
    const c = firstNonBlank.replace(/^\s+/, '')[0];
    if (c === '[' || c === '{') return 'json';
  }
  if (lines.some((l) => rstrip(l) === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

interface Outcome {
  fail?: { code: string; path: string };
  move?: { old: string; nw: string };
}

interface Edit {
  apply(tree: Tree): Outcome;
}

function fail(code: string, path: string): Outcome {
  return { fail: { code, path } };
}

const FORMATS = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

interface Args {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | undefined;
}

function parseArgs(argv: string[]): Args | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  const positionals: string[] = [];
  for (const arg of argv) {
    if (!endOpts && arg === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (arg === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        const v = arg.slice('--format='.length);
        if (!FORMATS.includes(v)) return null;
        format = v;
      } else {
        return null;
      }
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) return null;
  return { format: format ?? 'auto', check, strict, patch: positionals[0] };
}

// ---- Unified diffs (section 6) ----

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  hasPair: boolean;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffA: string | null;
  diffB: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    pairOld: undefined,
    pairNew: undefined,
    hasPair: false,
    renameFrom: undefined,
    renameTo: undefined,
    diffA: null,
    diffB: null,
    newFileMode: false,
    deletedFileMode: false,
    hunks: [],
  };
}

function parseDiffPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunkHeader(line: string, idx: number): Hunk {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!m) throw new ParseErr(idx + 1);
  return { a: parseInt(m[1], 10), items: [] };
}

function parseHunkBody(lines: string[], start: number, hunk: Hunk): number {
  let j = start;
  const raw: { line: string; item: BodyItem }[] = [];
  while (j < lines.length) {
    const L = lines[j];
    if (L.startsWith('diff --git ')) break;
    if (L.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
    if (L.startsWith('@@')) break;
    if (L === '') {
      raw.push({ line: L, item: { kind: 'ctx', text: '', noNl: false } });
      j++;
      continue;
    }
    const c = L[0];
    if (c === ' ' || c === '-' || c === '+') {
      raw.push({ line: L, item: { kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: L.slice(1), noNl: false } });
      j++;
      continue;
    }
    if (c === '\\') {
      for (let k = raw.length - 1; k >= 0; k--) {
        raw[k].item.noNl = true;
        break;
      }
      j++;
      continue;
    }
    break;
  }
  let end = raw.length;
  while (end > 0) {
    const r = raw[end - 1];
    if (r.line === '' && r.item.kind === 'ctx') end--;
    else break;
  }
  hunk.items = raw.slice(0, end).map((r) => r.item);
  return j;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHunks = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const L = lines[i];
    if (L.startsWith('diff --git ')) {
      const rest = L.slice('diff --git '.length);
      if (!rest.startsWith('a/')) throw new ParseErr(i + 1);
      const sep = rest.indexOf(' b/', 2);
      if (sep === -1) throw new ParseErr(i + 1);
      const a = rest.slice(2, sep);
      const b = rest.slice(sep + 3);
      if (a === '' || b === '') throw new ParseErr(i + 1);
      cur = newSection();
      cur.diffA = a;
      cur.diffB = b;
      sections.push(cur);
      inHunks = false;
      i++;
      continue;
    }
    if (L.startsWith('@@')) {
      if (cur === null) throw new ParseErr(i + 1);
      const h = parseHunkHeader(L, i);
      cur.hunks.push(h);
      inHunks = true;
      i = parseHunkBody(lines, i + 1, h);
      continue;
    }
    if (cur !== null && !inHunks) {
      if (L.startsWith('--- ')) {
        if (i + 1 < n && lines[i + 1].startsWith('+++ ')) {
          if (!cur.hasPair) {
            cur.pairOld = parseDiffPath(L);
            cur.pairNew = parseDiffPath(lines[i + 1]);
            cur.hasPair = true;
          }
          i += 2;
          continue;
        }
        throw new ParseErr(i + 2);
      }
      if (L.startsWith('+++ ')) {
        if (cur.pairNew === undefined) cur.pairNew = parseDiffPath(L);
        i++;
        continue;
      }
      if (L.startsWith('rename from ')) {
        if (cur.renameFrom === undefined) cur.renameFrom = L.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (L.startsWith('rename to ')) {
        if (cur.renameTo === undefined) cur.renameTo = L.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (L.startsWith('new file mode')) {
        cur.newFileMode = true;
        i++;
        continue;
      }
      if (L.startsWith('deleted file mode')) {
        cur.deletedFileMode = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (L.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      cur = newSection();
      cur.pairOld = parseDiffPath(L);
      cur.pairNew = parseDiffPath(lines[i + 1]);
      cur.hasPair = true;
      sections.push(cur);
      inHunks = false;
      i += 2;
      continue;
    }
    i++;
  }
  return sections.map((sec) => makeUnifiedEdit(sec, strict));
}

function makeUnifiedEdit(sec: Section, strict: boolean): Edit {
  return {
    apply(tree: Tree): Outcome {
      const oldPath = sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom ?? sec.diffA ?? null;
      const newPath = sec.pairNew !== undefined ? sec.pairNew : sec.renameTo ?? sec.diffB ?? null;
      const isCreation = oldPath === null || sec.newFileMode;
      const isDeletion = newPath === null || sec.deletedFileMode;
      if (isCreation) {
        const np = newPath ?? sec.diffB ?? '';
        if (!isSafe(np)) return fail('unsafe', np);
        if (tree.exists(np)) return fail('exists', np);
        const plus: string[] = [];
        let hasPlus = false;
        let noNl = false;
        for (const h of sec.hunks) {
          for (const it of h.items) {
            if (it.kind === 'new') {
              plus.push(it.text);
              hasPlus = true;
              noNl = it.noNl;
            }
          }
        }
        tree.set(np, serializeFile({ lines: plus, eol: '\n', endsWithBreak: hasPlus ? !noNl : false }));
        return {};
      }
      if (isDeletion) {
        const op = oldPath ?? sec.diffA ?? '';
        if (!isSafe(op)) return fail('unsafe', op);
        if (!tree.exists(op)) return fail('missing', op);
        tree.set(op, null);
        return {};
      }
      if (oldPath !== null && newPath !== null && oldPath !== newPath) {
        if (!isSafe(oldPath)) return fail('unsafe', oldPath);
        if (!isSafe(newPath)) return fail('unsafe', newPath);
        if (!tree.exists(oldPath)) return fail('missing', oldPath);
        if (tree.exists(newPath)) return fail('exists', newPath);
        const content = tree.get(oldPath);
        if (content === null) return fail('missing', oldPath);
        const f = parseFile(content);
        const err = applyHunks(f, sec.hunks, strict);
        if (err) return fail(err, oldPath);
        tree.set(oldPath, null);
        tree.set(newPath, serializeFile(f));
        return { move: { old: oldPath, nw: newPath } };
      }
      const p = oldPath ?? '';
      if (!isSafe(p)) return fail('unsafe', p);
      if (!tree.exists(p)) return fail('missing', p);
      const content = tree.get(p);
      if (content === null) return fail('missing', p);
      const f = parseFile(content);
      const err = applyHunks(f, sec.hunks, strict);
      if (err) return fail(err, p);
      tree.set(p, serializeFile(f));
      return {};
    },
  };
}

// ---- SEARCH/REPLACE blocks (section 7) ----

function makeSrEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return {
    apply(tree: Tree): Outcome {
      if (!isSafe(path)) return fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.exists(path)) return fail('exists', path);
        tree.set(path, serializeFile({ lines: [...newLines], eol: '\n', endsWithBreak: newLines.length > 0 }));
        return {};
      }
      const content = tree.get(path);
      if (content === null) return fail('missing', path);
      const f = parseFile(content);
      const found = findTierMax(f.lines, oldLines, strict ? 0 : 2);
      if (!found) return fail('no-match', path);
      if (found.occ.length > 1) return fail('ambiguous', path);
      const pos = found.occ[0];
      const repl = newLines.map((ln) => {
        if (found.tier === 2) {
          const p = leadingOf(oldLines[0]);
          const fl = leadingOf(f.lines[pos]);
          if (ln !== '' && !/^[ \t]+$/.test(ln) && ln.startsWith(p)) return fl + ln.slice(p.length);
        }
        return ln;
      });
      f.lines.splice(pos, oldLines.length, ...repl);
      tree.set(path, serializeFile(f));
      return {};
    },
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (rstrip(lines[i]) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseErr(searchIdx + 1);
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = rstrip(lines[j]);
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq === -1) throw new ParseErr(searchIdx + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = rstrip(lines[j]);
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep === -1) throw new ParseErr(searchIdx + 1);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(makeSrEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (section 8) ----

interface V4aChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

function isV4aSectionStart(L: string): boolean {
  return L.startsWith('*** Add File: ') || L.startsWith('*** Delete File: ') || L.startsWith('*** Update File: ');
}

function makeV4aAdd(path: string, fileLines: string[]): Edit {
  return {
    apply(tree: Tree): Outcome {
      if (!isSafe(path)) return fail('unsafe', path);
      if (tree.exists(path)) return fail('exists', path);
      tree.set(path, serializeFile({ lines: [...fileLines], eol: '\n', endsWithBreak: fileLines.length > 0 }));
      return {};
    },
  };
}

function makeV4aDelete(path: string): Edit {
  return {
    apply(tree: Tree): Outcome {
      if (!isSafe(path)) return fail('unsafe', path);
      if (!tree.exists(path)) return fail('missing', path);
      tree.set(path, null);
      return {};
    },
  };
}

function makeV4aUpdate(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return {
    apply(tree: Tree): Outcome {
      if (!isSafe(path)) return fail('unsafe', path);
      const content = tree.get(path);
      if (content === null) return fail('missing', path);
      if (moveTo !== null) {
        if (!isSafe(moveTo)) return fail('unsafe', moveTo);
        if (tree.exists(moveTo)) return fail('exists', moveTo);
      }
      const maxTier = strict ? 0 : 2;
      const f = parseFile(content);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          let foundIdx = -1;
          for (let t = 0; t <= maxTier && foundIdx < 0; t++) {
            for (let k = cursor; k < f.lines.length; k++) {
              if (lineEq(f.lines[k], ch.anchor as string, t)) {
                foundIdx = k;
                break;
              }
            }
          }
          if (foundIdx < 0) return fail('no-match', path);
          cursor = foundIdx + 1;
        }
        const oLines = ch.items.filter((i) => i.kind === 'ctx' || i.kind === 'old').map((i) => i.text);
        if (oLines.length === 0) {
          const pos = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
          const repl = buildReplacement(ch.items, f.lines, pos, 0);
          f.lines.splice(pos, 0, ...repl);
          cursor = pos + repl.length;
        } else {
          let found: { tier: number; pos: number } | null = null;
          for (let t = 0; t <= maxTier && !found; t++) {
            const occ = findOccurrences(f.lines, oLines, t, cursor);
            const good = ch.eof ? occ.filter((p) => p + oLines.length === f.lines.length) : occ;
            if (good.length > 0) found = { tier: t, pos: good[0] };
          }
          if (!found) return fail('no-match', path);
          const repl = buildReplacement(ch.items, f.lines, found.pos, found.tier);
          f.lines.splice(found.pos, oLines.length, ...repl);
          cursor = found.pos + repl.length;
        }
      }
      const out = serializeFile(f);
      if (moveTo !== null) {
        tree.set(path, null);
        tree.set(moveTo, out);
        return { move: { old: path, nw: moveTo } };
      }
      tree.set(path, out);
      return {};
    },
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const raw = lines[i];
    if (raw.trim() === '') {
      i++;
      continue;
    }
    if (raw.startsWith('*** Add File: ')) {
      const path = raw.slice('*** Add File: '.length).trim();
      i++;
      const collected: number[] = [];
      let j = i;
      while (j < last) {
        const L = lines[j];
        if (isV4aSectionStart(L)) break;
        if (L === '') {
          collected.push(j);
          j++;
          continue;
        }
        if (L.startsWith('+')) {
          collected.push(j);
          j++;
          continue;
        }
        throw new ParseErr(j + 1);
      }
      let end = collected.length;
      while (end > 0 && lines[collected[end - 1]] === '') end--;
      const fileLines: string[] = [];
      for (let k = 0; k < end; k++) {
        const L = lines[collected[k]];
        fileLines.push(L === '' ? '' : L.slice(1));
      }
      edits.push(makeV4aAdd(path, fileLines));
      i = j;
      continue;
    }
    if (raw.startsWith('*** Delete File: ')) {
      const path = raw.slice('*** Delete File: '.length).trim();
      edits.push(makeV4aDelete(path));
      i++;
      continue;
    }
    if (raw.startsWith('*** Update File: ')) {
      const path = raw.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let hasChunk = false;
      while (i < last) {
        const L = lines[i];
        if (isV4aSectionStart(L)) break;
        const t = L.trim();
        if (t === '*** End of File' && !L.startsWith(' ') && !L.startsWith('-') && !L.startsWith('+')) {
          if (cur === null) throw new ParseErr(i + 1);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          hasChunk = true;
          i++;
          continue;
        }
        if (L.startsWith('*** Move to: ')) {
          if (hasChunk || moveTo !== null || cur !== null) throw new ParseErr(i + 1);
          moveTo = L.slice('*** Move to: '.length).trim();
          i++;
          continue;
        }
        if (L.startsWith('@@')) {
          if (cur !== null) {
            chunks.push(cur);
            cur = null;
          }
          // SPEC section 8: an empty text after @@ is no anchor.
          const anchorText = L.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, items: [], eof: false };
          hasChunk = true;
          i++;
          continue;
        }
        if (L === '') {
          if (cur !== null) cur.items.push({ kind: 'ctx', text: '', noNl: false });
          i++;
          continue;
        }
        if (L[0] === ' ' || L[0] === '-' || L[0] === '+') {
          if (cur === null) {
            if (hasChunk) throw new ParseErr(i + 1);
            cur = { anchor: null, items: [], eof: false };
            hasChunk = true;
          }
          cur.items.push({ kind: L[0] === ' ' ? 'ctx' : L[0] === '-' ? 'old' : 'new', text: L.slice(1), noNl: false });
          i++;
          continue;
        }
        throw new ParseErr(i + 1);
      }
      if (cur !== null) {
        chunks.push(cur);
        cur = null;
      }
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1];
        while (lc.items.length > 0) {
          const it = lc.items[lc.items.length - 1];
          if (it.kind === 'ctx' && it.text === '') lc.items.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseErr(updateLine + 1);
      edits.push(makeV4aUpdate(path, moveTo, chunks, strict));
      continue;
    }
    throw new ParseErr(i + 1);
  }
  return edits;
}

// ---- JSON edits (section 9) ----

function splitNewStrLines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function jsonEdit(o: unknown): Edit | null {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const rec = o as Record<string, unknown>;
  if (typeof rec.path !== 'string' || typeof rec.command !== 'string') return null;
  const path = rec.path as string;
  if (rec.command === 'create') {
    if (typeof rec.file_text !== 'string') return null;
    const text = rec.file_text as string;
    return {
      apply(tree: Tree): Outcome {
        if (!isSafe(path)) return fail('unsafe', path);
        if (tree.exists(path)) return fail('exists', path);
        tree.set(path, text);
        return {};
      },
    };
  }
  if (rec.command === 'str_replace') {
    if (typeof rec.old_str !== 'string' || (rec.old_str as string).length === 0) return null;
    if ('new_str' in rec && typeof rec.new_str !== 'string') return null;
    const oldStr = rec.old_str as string;
    const newStr = ('new_str' in rec ? rec.new_str : '') as string;
    return {
      apply(tree: Tree): Outcome {
        if (!isSafe(path)) return fail('unsafe', path);
        const content = tree.get(path);
        if (content === null) return fail('missing', path);
        const f = parseFile(content);
        let text = content;
        let os = oldStr;
        let ns = newStr;
        if (f.eol === '\r\n') {
          text = content.replace(/\r\n/g, '\n');
          os = oldStr.replace(/\r\n/g, '\n');
          ns = newStr.replace(/\r\n/g, '\n');
        }
        let count = 0;
        let foundIdx = -1;
        let idx = text.indexOf(os);
        while (idx !== -1) {
          count++;
          if (foundIdx === -1) foundIdx = idx;
          idx = text.indexOf(os, idx + 1);
        }
        if (count === 0) return fail('no-match', path);
        if (count > 1) return fail('ambiguous', path);
        let result = text.slice(0, foundIdx) + ns + text.slice(foundIdx + os.length);
        if (f.eol === '\r\n') result = result.replace(/\n/g, '\r\n');
        tree.set(path, result);
        return {};
      },
    };
  }
  if (rec.command === 'insert') {
    if (!Number.isInteger(rec.insert_line) || typeof rec.new_str !== 'string') return null;
    const line = rec.insert_line as number;
    const newStr = rec.new_str as string;
    return {
      apply(tree: Tree): Outcome {
        if (!isSafe(path)) return fail('unsafe', path);
        const content = tree.get(path);
        if (content === null) return fail('missing', path);
        const f = parseFile(content);
        if (line < 0 || line > f.lines.length) return fail('no-match', path);
        const ins = splitNewStrLines(newStr);
        f.lines.splice(line, 0, ...ins);
        tree.set(path, serializeFile(f));
        return {};
      },
    };
  }
  return null;
}

function parseJson(lines: string[], patchText: string): Edit[] {
  const m = /\S/.exec(patchText);
  if (m === null) return [];
  const firstChar = patchText[m.index];
  const arrayStartLine = patchText.slice(0, m.index).split('\n').length;
  if (firstChar === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseErr(arrayStartLine);
    }
    if (!Array.isArray(arr)) throw new ParseErr(arrayStartLine);
    const edits: Edit[] = [];
    for (const el of arr) {
      const e = jsonEdit(el);
      if (e === null) throw new ParseErr(arrayStartLine);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (L.trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(L);
    } catch {
      throw new ParseErr(i + 1);
    }
    const e = jsonEdit(obj);
    if (e === null) throw new ParseErr(i + 1);
    edits.push(e);
  }
  return edits;
}

// ---- Output and entry point (sections 1, 2, 10) ----

function writeStdout(text: string): void {
  writeFileSync(1, text, 'utf8');
}

function changeLines(tree: Tree, moves: { old: string; nw: string }[]): string[] {
  const rows: { key: string; line: string }[] = [];
  for (const p of tree.touched()) {
    const o = tree.orig(p);
    const c = tree.get(p);
    if (o === c) continue;
    if (o === null && c !== null) rows.push({ key: p, line: `A ${p}` });
    else if (o !== null && c === null) rows.push({ key: p, line: `D ${p}` });
    else rows.push({ key: p, line: `M ${p}` });
  }
  for (const mv of moves) {
    const oOld = tree.orig(mv.old);
    const oNew = tree.orig(mv.nw);
    const cOld = tree.get(mv.old);
    const cNew = tree.get(mv.nw);
    if (oOld !== null && oNew === null && cOld === null && cNew !== null) {
      const di = rows.findIndex((r) => r.line === `D ${mv.old}`);
      const ai = rows.findIndex((r) => r.line === `A ${mv.nw}`);
      if (di >= 0 && ai >= 0) {
        rows.splice(Math.max(di, ai), 1);
        rows.splice(Math.min(di, ai), 1);
        rows.push({ key: mv.nw, line: `R ${mv.old} -> ${mv.nw}` });
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  return rows.map((r) => r.line);
}

function writeChanges(tree: Tree): void {
  for (const p of tree.touched()) {
    const o = tree.orig(p);
    const c = tree.get(p);
    if (o === c) continue;
    if (c === null) {
      try {
        rmSync(p, { force: true });
      } catch {
        // nothing to remove
      }
    } else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, c, 'utf8');
    }
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    writeStdout('error: usage\n');
    process.exit(2);
  }
  let patchText: string;
  try {
    patchText = args.patch === undefined || args.patch === '-' ? readFileSync(0, 'utf8') : readFileSync(args.patch, 'utf8');
  } catch {
    writeStdout('error: no-patch\n');
    process.exit(2);
  }
  const lines = splitPatchLines(patchText);
  let fmt = args.format;
  if (fmt === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) {
      writeStdout('error: format\n');
      process.exit(2);
    }
    fmt = detected;
  }
  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines, args.strict);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines, args.strict);
    else if (fmt === 'v4a') edits = parseV4a(lines, args.strict);
    else edits = parseJson(lines, patchText);
  } catch (e) {
    if (e instanceof ParseErr) {
      writeStdout(`error: parse ${e.line}\n`);
      process.exit(2);
    }
    throw e;
  }
  if (edits.length === 0) {
    writeStdout('error: parse 1\n');
    process.exit(2);
  }
  const tree = new Tree();
  const failures: { code: string; path: string }[] = [];
  const moves: { old: string; nw: string }[] = [];
  for (const edit of edits) {
    const outcome = edit.apply(tree);
    if (outcome.fail) failures.push(outcome.fail);
    else if (outcome.move) moves.push(outcome.move);
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}\n`).join('') + `failed: ${failures.length} of ${edits.length} edits\n`;
    writeStdout(out);
    process.exit(1);
  }
  const changed = changeLines(tree, moves);
  if (!args.check) writeChanges(tree);
  const n = changed.length;
  writeStdout(changed.map((l) => `${l}\n`).join('') + (n === 1 ? 'ok: 1 file\n' : `ok: ${n} files\n`));
  process.exit(0);
}

if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  main();
}
