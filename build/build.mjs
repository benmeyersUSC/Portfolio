#!/usr/bin/env node
// Portfolio hub build.
//
// Discovers satellite repos that opt in with a `.showcase.yml` on their default
// branch, enriches them from the GitHub API, and emits data/projects.json.
// Screenshots are not vendored yet (that is a later milestone).
//
//   node build/build.mjs               # scan, emit data/projects.json, check links
//   node build/build.mjs --discover    # milestone-1 report only, writes nothing
//   node build/build.mjs --dry-run     # build everything, print JSON, write nothing
//   node build/build.mjs --no-check    # skip the post-build URL validation
//   node build/build.mjs --parse f.yml # parse one local file (parser check)
//   node build/build.mjs --owner NAME  # override the detected owner
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./yaml.mjs";
import { validate, slugify, titleFromFilename, compileGlob, humanBytes } from "./manifest.mjs";
import { resolveToken, makeClient, listRepos, getFile, listDir, getPagesUrl, checkUrl, pmap } from "./github.mjs";

const MANIFEST = ".showcase.yml";
const FALLBACK_TOPIC = "showcase";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { discover: false, dryRun: false, check: true, parse: null, owner: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--discover") args.discover = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-check") args.check = false;
    else if (a === "--json") args.json = true;
    else if (a === "--parse") args.parse = argv[++i];
    else if (a === "--owner") args.owner = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 14).join("\n").replace(/^\/\/ ?/gm, ""));
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

// [owner, repo] of this hub checkout, from CI env or the git remote.
function detectSelf() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY.split("/");
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
    if (m) return [m[1], m[2]];
  } catch {
    // not a git checkout, or no origin
  }
  return [null, null];
}

const rawUrl = (o, r, b, p) => `https://raw.githubusercontent.com/${o}/${r}/${b}/${p.split("/").map(encodeURIComponent).join("/")}`;
const blobUrl = (o, r, b, p) => `https://github.com/${o}/${r}/blob/${b}/${p.split("/").map(encodeURIComponent).join("/")}`;

async function discover({ owner, client, hubRepo }) {
  const repos = await listRepos(client, owner);
  const candidates = [];
  const skipped = [];
  for (const r of repos) {
    if (r.fork) skipped.push({ name: r.name, reason: "fork" });
    else if (r.archived) skipped.push({ name: r.name, reason: "archived" });
    else if (hubRepo && r.name === hubRepo) skipped.push({ name: r.name, reason: "this hub repo" });
    else candidates.push(r);
  }

  const found = [];
  const noManifest = [];
  await pmap(candidates, 8, async (r) => {
    let file = null;
    try {
      file = await getFile(client, owner, r.name, MANIFEST, r.default_branch);
    } catch (err) {
      found.push({ repo: r, source: MANIFEST, manifest: null, error: `fetch failed: ${err.message}` });
      return;
    }
    if (file) {
      let manifest = null, error = null;
      try {
        manifest = parseYaml(file.text);
      } catch (err) {
        error = `YAML parse failed: ${err.message}`;
      }
      found.push({ repo: r, source: MANIFEST, manifest, error });
    } else if ((r.topics || []).includes(FALLBACK_TOPIC)) {
      found.push({ repo: r, source: `topic:${FALLBACK_TOPIC}`, synthesized: true, manifest: { title: r.name, tagline: r.description || "" } });
    } else {
      noManifest.push({ name: r.name, reason: `no ${MANIFEST}, no "${FALLBACK_TOPIC}" topic` });
    }
  });

  found.sort((a, b) => {
    const ao = a.manifest?.order ?? 1e9, bo = b.manifest?.order ?? 1e9;
    return ao !== bo ? ao - bo : b.repo.pushed_at.localeCompare(a.repo.pushed_at);
  });
  return { repos, skipped, found, noManifest };
}

// Explicit `docs:` entries first, then anything matched by `docs_glob` that was
// not already listed. Every doc keeps a live, branch-pinned raw URL.
async function resolveDocs({ client, owner, repo, branch, manifest, problems }) {
  const docs = [];
  const seen = new Set();

  for (const d of manifest.docs || []) {
    if (!d?.path) continue;
    let meta = null;
    try {
      meta = await getFile(client, owner, repo, d.path, branch);
    } catch (err) {
      problems.push(`docs: ${d.path}: ${err.message}`);
    }
    if (!meta) { problems.push(`docs: ${d.path} not found on ${branch}`); continue; }
    seen.add(d.path);
    docs.push({
      title: d.title || titleFromFilename(d.path.split("/").pop()),
      description: d.description ? String(d.description).trim() : null,
      path: d.path,
      raw_url: rawUrl(owner, repo, branch, d.path),
      blob_url: blobUrl(owner, repo, branch, d.path),
      bytes: meta.size,
      size_label: humanBytes(meta.size),
    });
  }

  if (manifest.docs_glob) {
    const { dir, test } = compileGlob(manifest.docs_glob);
    const entries = await listDir(client, owner, repo, dir, branch);
    const matched = entries
      .filter((e) => e.type === "file" && test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (matched.length === 0) problems.push(`docs_glob "${manifest.docs_glob}" matched nothing`);
    for (const e of matched) {
      if (seen.has(e.path)) continue;
      docs.push({
        title: titleFromFilename(e.name),
        description: null,
        path: e.path,
        raw_url: rawUrl(owner, repo, branch, e.path),
        blob_url: blobUrl(owner, repo, branch, e.path),
        bytes: e.size,
        size_label: humanBytes(e.size),
      });
    }
  }
  return docs;
}

async function project({ client, owner, entry }) {
  const r = entry.repo;
  const m = entry.manifest || {};
  const branch = r.default_branch;
  const problems = [];

  let demo = m.demo || null;
  if (!demo && r.has_pages) demo = await getPagesUrl(client, owner, r.name);

  const docs = await resolveDocs({ client, owner, repo: r.name, branch, manifest: m, problems });

  return {
    project: {
      slug: slugify(m.title || r.name),
      title: m.title || r.name,
      tagline: m.tagline || r.description || "",
      description: m.description ? String(m.description).trim() : null,
      kind: m.kind || "project",
      repo_url: r.html_url,
      demo_url: demo,
      default_branch: branch,
      language: r.language,
      tags: [...new Set([...(m.tags || []), ...(r.topics || [])])],
      stars: r.stargazers_count,
      pushed_at: r.pushed_at,
      order: m.order ?? null,
      screenshots: [],
      docs,
    },
    problems,
  };
}

function reportDiscovery(result, { owner, auth, stats }) {
  const { found, skipped, noManifest, repos } = result;
  const line = (s = "") => console.log(s);
  line();
  line(`Portfolio discovery -- ${owner}`);
  line(`auth: ${auth}   repos scanned: ${repos.length}   API calls: ${stats.calls}` +
       (stats.remaining != null ? `   rate limit: ${stats.remaining}/${stats.limit} left` : ""));
  line("=".repeat(72));
  if (found.length === 0) {
    line();
    line(`No participating repos yet. A repo opts in by committing ${MANIFEST} to`);
    line(`its default branch, or by carrying the "${FALLBACK_TOPIC}" GitHub topic.`);
  }
  let bad = 0;
  for (const f of found) {
    const r = f.repo, m = f.manifest || {};
    const { errors, warnings } = f.error ? { errors: [f.error], warnings: [] } : validate(m);
    if (errors.length) bad++;
    line();
    line(`[${errors.length ? "FAIL" : m.hidden ? "HIDE" : "OK  "}] ${r.name}  (${f.source})`);
    line(`       title     ${m.title ?? "--"}`);
    line(`       tagline   ${m.tagline ?? "--"}`);
    line(`       kind      ${m.kind || "project"}`);
    line(`       order     ${m.order ?? "--"}`);
    if (m.docs_glob) line(`       glob      ${m.docs_glob}`);
    for (const e of errors) line(`       ERROR     ${e}`);
    for (const w of warnings) line(`       warn      ${w}`);
  }
  line();
  line("-".repeat(72));
  line(`Not participating (${noManifest.length}):`);
  for (const n of [...noManifest].sort((a, b) => a.name.localeCompare(b.name))) line(`   ${n.name.padEnd(40)} ${n.reason}`);
  if (skipped.length) {
    line();
    line(`Skipped (${skipped.length}):`);
    for (const s of skipped) line(`   ${s.name.padEnd(40)} ${s.reason}`);
  }
  line();
  line(`Summary: ${found.length} participating, ${bad} with errors, ${noManifest.length} not participating, ${skipped.length} skipped.`);
  line();
  return bad;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.parse) {
    const parsed = parseYaml(readFileSync(args.parse, "utf8"));
    const { errors, warnings } = validate(parsed);
    console.log(JSON.stringify(parsed, null, 2));
    for (const e of errors) console.error(`ERROR  ${e}`);
    for (const w of warnings) console.error(`warn   ${w}`);
    process.exit(errors.length ? 1 : 0);
  }

  if (typeof fetch !== "function") {
    console.error(`This script needs Node 18+ for native fetch (running ${process.version}).`);
    process.exit(2);
  }

  const [selfOwner, selfRepo] = detectSelf();
  const owner = args.owner || process.env.GITHUB_OWNER || selfOwner;
  if (!owner) throw new Error("could not determine owner; pass --owner NAME or set GITHUB_OWNER");
  const hubRepo = owner === selfOwner ? selfRepo : null;

  const { token, source } = resolveToken();
  const client = makeClient(token);
  const result = await discover({ owner, client, hubRepo });

  if (args.discover) {
    process.exitCode = reportDiscovery(result, { owner, auth: source, stats: client.stats }) ? 1 : 0;
    return;
  }

  // Drop manifests that failed to parse or validate; a broken satellite must
  // not take the whole site down, but it must be loud.
  const usable = [];
  let failed = 0;
  for (const f of result.found) {
    const { errors } = f.error ? { errors: [f.error] } : validate(f.manifest || {});
    if (errors.length) {
      failed++;
      console.error(`SKIP  ${f.repo.name}: ${errors.join("; ")}`);
    } else if (f.manifest?.hidden) {
      console.error(`HIDE  ${f.repo.name}: hidden: true`);
    } else {
      usable.push(f);
    }
  }

  const built = await pmap(usable, 6, (entry) => project({ client, owner, entry }));
  for (const b of built) {
    for (const p of b.problems) console.error(`WARN  ${b.project.slug}: ${p}`);
  }

  const projects = built.map((b) => b.project);
  projects.sort((a, b) => {
    const ao = a.order ?? 1e9, bo = b.order ?? 1e9;
    return ao !== bo ? ao - bo : b.pushed_at.localeCompare(a.pushed_at);
  });

  const payload = { generated_at: new Date().toISOString(), owner, projects };

  if (args.check) {
    const urls = [...new Set(projects.flatMap((p) => [p.repo_url, p.demo_url, ...p.docs.map((d) => d.raw_url)].filter(Boolean)))];
    const checks = await pmap(urls, 8, checkUrl);
    const broken = checks.filter((c) => !c.ok);
    console.error(`\nURL check: ${checks.length - broken.length}/${checks.length} OK`);
    for (const b of broken) console.error(`  BROKEN ${b.status || b.error}  ${b.url}`);
    if (broken.length) process.exitCode = 1;
  }

  if (args.dryRun || args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    mkdirSync(resolve(ROOT, "data"), { recursive: true });
    writeFileSync(resolve(ROOT, "data/projects.json"), JSON.stringify(payload, null, 2) + "\n");
    console.error(`\nWrote data/projects.json -- ${projects.length} projects, ${projects.reduce((n, p) => n + p.docs.length, 0)} docs.`);
    console.error(`API calls: ${client.stats.calls}${client.stats.remaining != null ? `, rate limit ${client.stats.remaining}/${client.stats.limit} left` : ""}.`);
    if (failed) console.error(`${failed} manifest(s) skipped -- see SKIP lines above.`);
  }
}

main().catch((err) => {
  console.error(`\nbuild failed: ${err.message}`);
  process.exit(1);
});
