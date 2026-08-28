// Manifest schema: validation, normalization, and the derived-value helpers.
// The schema is the one in SPEC.md plus two additions:
//   kind:      "project" (default) | "writings" -- how the frontend renders it
//   docs_glob: e.g. "*.pdf" -- enumerate docs from the repo instead of listing
//              them by hand, so adding a PDF needs no manifest edit
export const KNOWN_KEYS = [
  "title", "tagline", "description", "tags", "order", "demo", "hidden",
  "screenshots", "docs", "kind", "docs_glob",
];
export const KINDS = ["project", "writings"];

export function validate(m) {
  const errors = [];
  const warnings = [];
  if (typeof m !== "object" || m === null || Array.isArray(m)) return { errors: ["manifest is not a mapping"], warnings };
  if (!m.title) errors.push("missing required key: title");
  else if (typeof m.title !== "string") errors.push("title must be a string");
  if (!m.tagline) errors.push("missing required key: tagline");
  else if (typeof m.tagline !== "string") errors.push("tagline must be a string");
  else if (m.tagline.split(/\s+/).length > 16) warnings.push("tagline is longer than ~10 words");
  if (m.tags != null && !Array.isArray(m.tags)) errors.push("tags must be a list");
  if (m.order != null && typeof m.order !== "number") errors.push("order must be a number");
  if (m.demo != null && !/^https?:\/\//.test(String(m.demo))) errors.push("demo must be an absolute http(s) URL");
  if (m.hidden != null && typeof m.hidden !== "boolean") errors.push("hidden must be true or false");
  if (m.kind != null && !KINDS.includes(m.kind)) errors.push(`kind must be one of: ${KINDS.join(", ")}`);
  if (m.docs_glob != null) {
    if (typeof m.docs_glob !== "string") errors.push("docs_glob must be a string");
    else if (m.docs_glob.includes("**")) errors.push("docs_glob does not support ** (one directory level only)");
    else if (!m.docs_glob.includes("*") && !m.docs_glob.includes("?")) warnings.push("docs_glob has no wildcard; did you mean docs?");
  }
  for (const [key, list] of [["screenshots", m.screenshots], ["docs", m.docs]]) {
    if (list == null) continue;
    if (!Array.isArray(list)) { errors.push(`${key} must be a list`); continue; }
    list.forEach((item, i) => {
      if (typeof item !== "object" || item === null) { errors.push(`${key}[${i}] must be a mapping`); return; }
      if (!item.path) errors.push(`${key}[${i}] missing required key: path`);
      else if (/^https?:\/\//.test(String(item.path))) errors.push(`${key}[${i}].path must be a repo-relative path, not a URL`);
      else if (String(item.path).startsWith("/") || String(item.path).includes("..")) errors.push(`${key}[${i}].path must stay inside the repo`);
      if (key === "docs" && !item.title) warnings.push(`docs[${i}] has no title; falling back to the filename`);
      if (key === "screenshots" && !item.alt) warnings.push(`screenshots[${i}] has no alt text`);
    });
  }
  for (const key of Object.keys(m)) {
    if (!KNOWN_KEYS.includes(key)) warnings.push(`unrecognized key: ${key}`);
  }
  return { errors, warnings };
}

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// "Why_Overparameterization_Works.pdf" -> "Why Overparameterization Works"
// "ShannonKelly.pdf"                   -> "Shannon Kelly"
// "j-vision.pdf"                       -> "J Vision"
export function titleFromFilename(filename) {
  const stem = filename.replace(/\.[^.]+$/, "");
  return stem
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// Translate a one-level glob ("*.pdf", "papers/*.pdf") into a directory to
// list plus a regex to filter that directory's filenames.
export function compileGlob(glob) {
  const idx = glob.lastIndexOf("/");
  const dir = idx === -1 ? "" : glob.slice(0, idx);
  const pattern = idx === -1 ? glob : glob.slice(idx + 1);
  const rx = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$", "i");
  return { dir, test: (name) => rx.test(name) };
}

export function humanBytes(n) {
  if (!Number.isFinite(n)) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
