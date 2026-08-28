// Thin GitHub REST helpers. Auth comes from GITHUB_TOKEN / GH_TOKEN, falling
// back to `gh auth token` for local runs. Unauthenticated works too, at the
// 60 req/hr per-IP limit -- fine for discovery, thin for a full build.
import { execFileSync } from "node:child_process";

const API = "https://api.github.com";

export function resolveToken() {
  if (process.env.GITHUB_TOKEN) return { token: process.env.GITHUB_TOKEN, source: "GITHUB_TOKEN" };
  if (process.env.GH_TOKEN) return { token: process.env.GH_TOKEN, source: "GH_TOKEN" };
  try {
    const out = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (out) return { token: out, source: "gh auth token" };
  } catch {
    // gh missing or not logged in; fall through to anonymous.
  }
  return { token: null, source: "anonymous" };
}

export function makeClient(token) {
  const stats = { calls: 0, remaining: null, limit: null, resetAt: null };

  async function request(path, { raw = false } = {}) {
    const headers = { Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json", "User-Agent": "portfolio-hub-build" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const url = path.startsWith("http") ? path : `${API}${path}`;
    const res = await fetch(url, { headers });
    stats.calls++;
    if (res.headers.has("x-ratelimit-remaining")) {
      stats.remaining = Number(res.headers.get("x-ratelimit-remaining"));
      stats.limit = Number(res.headers.get("x-ratelimit-limit"));
      stats.resetAt = new Date(Number(res.headers.get("x-ratelimit-reset")) * 1000);
    }
    if (res.status === 404) return { status: 404, body: null, res };
    if (res.status === 403 && stats.remaining === 0) {
      throw new Error(`GitHub rate limit exhausted (resets ${stats.resetAt?.toISOString()}). Set GITHUB_TOKEN to raise the limit to 5000/hr.`);
    }
    if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText} for ${url}`);
    return { status: res.status, body: raw ? await res.text() : await res.json(), res };
  }

  return { request, stats };
}

export async function listRepos(client, owner) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const { body } = await client.request(`/users/${owner}/repos?per_page=100&type=owner&sort=pushed&page=${page}`);
    if (!Array.isArray(body) || body.length === 0) break;
    out.push(...body);
    if (body.length < 100) break;
  }
  return out;
}

// Returns the decoded file text, or null on 404.
export async function getFile(client, owner, repo, path, ref) {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const { status, body } = await client.request(`/repos/${owner}/${repo}/contents/${path}${q}`);
  if (status === 404 || !body) return null;
  if (Array.isArray(body)) return null; // a directory, not a file
  const text = body.encoding === "base64" ? Buffer.from(body.content, "base64").toString("utf8") : body.content;
  return { text, size: body.size, sha: body.sha, html_url: body.html_url };
}

// Concurrency-limited map, to stay polite with the API.
export async function pmap(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// Directory listing via the contents API. Returns [] for a missing directory.
export async function listDir(client, owner, repo, dir, ref) {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const path = dir ? `/${dir.split("/").map(encodeURIComponent).join("/")}` : "";
  const { status, body } = await client.request(`/repos/${owner}/${repo}/contents${path}${q}`);
  if (status === 404 || !Array.isArray(body)) return [];
  return body;
}

// The repo's GitHub Pages site URL, or null if Pages is not enabled.
export async function getPagesUrl(client, owner, repo) {
  try {
    const { status, body } = await client.request(`/repos/${owner}/${repo}/pages`);
    return status === 404 || !body ? null : body.html_url || null;
  } catch {
    return null; // Pages info can 403 on some repos; not fatal.
  }
}

// HEAD a URL and report the status, for post-build link validation.
export async function checkUrl(url) {
  try {
    let res = await fetch(url, { method: "HEAD", redirect: "follow" });
    if (res.status === 405 || res.status === 501) res = await fetch(url, { method: "GET", redirect: "follow" });
    return { url, status: res.status, ok: res.ok };
  } catch (err) {
    return { url, status: 0, ok: false, error: err.message };
  }
}
