// Minimal YAML reader covering the `.showcase.yml` subset described in SPEC.md:
// scalars, block scalars (| and >), flow sequences, block sequences, and
// sequences of single-level mappings. Not a general YAML implementation --
// if a manifest needs more than this, swap in js-yaml.

function tokenize(src) {
  return src.replace(/\r\n?/g, "\n").split("\n").map((raw, i) => {
    const indent = raw.length - raw.replace(/^[ \t]+/, "").length;
    return { line: i + 1, indent, text: raw.slice(indent), raw };
  });
}

const isBlank = (t) => t.text === "" || t.text.startsWith("#");

// Strip an unquoted trailing `# comment`, respecting quotes.
function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i);
    }
  }
  return s;
}

function unquote(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    const body = s.slice(1, -1);
    return s[0] === '"' ? body.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : body.replace(/''/g, "'");
  }
  return s;
}

function scalar(raw) {
  const s = stripComment(raw).trim();
  if (s === "") return null;
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    return inner === "" ? [] : splitFlow(inner).map(scalar);
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    const out = {};
    const inner = s.slice(1, -1).trim();
    if (inner) for (const part of splitFlow(inner)) {
      const m = part.match(/^([^:]+):\s*(.*)$/);
      if (m) out[unquote(m[1].trim())] = scalar(m[2]);
    }
    return out;
  }
  if (s[0] === '"' || s[0] === "'") return unquote(s);
  if (s === "true" || s === "yes" || s === "on") return true;
  if (s === "false" || s === "no" || s === "off") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return Number.parseFloat(s);
  return s;
}

// Split "a, [b, c], d" on top-level commas only.
function splitFlow(s) {
  const out = [];
  let depth = 0, quote = null, cur = "";
  for (const c of s) {
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

const KEY = /^([A-Za-z0-9_.\-$]+):(?:\s+(.*))?$/;

// Gather a `|` / `>` block scalar: every line indented past `parentIndent`.
function blockScalar(toks, i, parentIndent, header) {
  const fold = header.startsWith(">");
  const chomp = header.includes("-") ? "strip" : header.includes("+") ? "keep" : "clip";
  const body = [];
  let base = null;
  while (i < toks.length) {
    const t = toks[i];
    if (t.text !== "" && t.indent <= parentIndent) break;
    if (t.text === "") { body.push(""); i++; continue; }
    if (base === null) base = t.indent;
    body.push(t.raw.slice(Math.min(base, t.indent)));
    i++;
  }
  while (body.length && body.at(-1) === "") body.pop();
  let text = fold
    ? body.reduce((acc, l) => (l === "" ? acc + "\n\n" : acc === "" || acc.endsWith("\n") ? acc + l : acc + " " + l), "")
    : body.join("\n");
  if (chomp !== "strip") text += "\n";
  return [text, i];
}

function parseNode(toks, i, indent) {
  while (i < toks.length && isBlank(toks[i])) i++;
  if (i >= toks.length) return [null, i];
  return toks[i].text.startsWith("- ") || toks[i].text === "-"
    ? parseSeq(toks, i, indent)
    : parseMap(toks, i, indent);
}

function parseMap(toks, i, indent) {
  const out = {};
  while (i < toks.length) {
    const t = toks[i];
    if (isBlank(t)) { i++; continue; }
    if (t.indent < indent) break;
    if (t.indent > indent) throw new Error(`line ${t.line}: unexpected indent`);
    const m = t.text.match(KEY);
    if (!m) throw new Error(`line ${t.line}: expected "key: value", got ${JSON.stringify(t.text)}`);
    const key = m[1];
    const rest = (m[2] ?? "").trim();
    i++;
    if (/^[|>][-+]?$/.test(stripComment(rest).trim())) {
      [out[key], i] = blockScalar(toks, i, t.indent, stripComment(rest).trim());
    } else if (rest === "" || rest.startsWith("#")) {
      let j = i;
      while (j < toks.length && isBlank(toks[j])) j++;
      // A nested block is either deeper, or a sequence at the same indent.
      if (j < toks.length && (toks[j].indent > t.indent || (toks[j].indent === t.indent && toks[j].text.startsWith("-")))) {
        [out[key], i] = parseNode(toks, j, toks[j].indent);
      } else {
        out[key] = null;
      }
    } else {
      out[key] = scalar(rest);
    }
  }
  return [out, i];
}

function parseSeq(toks, i, indent) {
  const out = [];
  while (i < toks.length) {
    const t = toks[i];
    if (isBlank(t)) { i++; continue; }
    if (t.indent < indent) break;
    if (t.indent > indent || !(t.text.startsWith("- ") || t.text === "-")) break;
    const inline = t.text === "-" ? "" : t.text.slice(2).trim();
    const itemIndent = t.indent + 2;
    i++;
    const km = inline.match(KEY);
    if (km) {
      // A mapping item: the inline pair plus any following deeper lines.
      const item = {};
      const rest = (km[2] ?? "").trim();
      if (/^[|>][-+]?$/.test(rest)) {
        [item[km[1]], i] = blockScalar(toks, i, t.indent, rest);
      } else if (rest === "") {
        let j = i;
        while (j < toks.length && isBlank(toks[j])) j++;
        if (j < toks.length && toks[j].indent > itemIndent) [item[km[1]], i] = parseNode(toks, j, toks[j].indent);
        else item[km[1]] = null;
      } else {
        item[km[1]] = scalar(rest);
      }
      let j = i;
      while (j < toks.length && isBlank(toks[j])) j++;
      if (j < toks.length && toks[j].indent > t.indent && !toks[j].text.startsWith("- ")) {
        const [more, next] = parseMap(toks, j, toks[j].indent);
        Object.assign(item, more);
        i = next;
      }
      out.push(item);
    } else if (inline === "") {
      let j = i;
      while (j < toks.length && isBlank(toks[j])) j++;
      if (j < toks.length && toks[j].indent > t.indent) { const [v, next] = parseNode(toks, j, toks[j].indent); out.push(v); i = next; }
      else out.push(null);
    } else {
      out.push(scalar(inline));
    }
  }
  return [out, i];
}

export function parseYaml(src) {
  const toks = tokenize(src).filter((t) => t.text !== "---" && t.text !== "...");
  let i = 0;
  while (i < toks.length && isBlank(toks[i])) i++;
  if (i >= toks.length) return {};
  const [value] = parseNode(toks, i, toks[i].indent);
  return value ?? {};
}
