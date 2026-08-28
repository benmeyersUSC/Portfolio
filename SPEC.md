# Portfolio hub — build spec

Drop this in the repo root as `SPEC.md` and open Claude Code with:
"Read SPEC.md. Build milestone 1 only, then stop and show me the output."

---

## What this repo is

A static GitHub Pages site that acts as a **hub**: it indexes my other repos and links
outward to their own Pages sites, demos, and PDFs. It hosts no application logic of its
own. Everything on it is generated at build time from data discovered in other repos.

Correctness of the mechanism comes first. Visual design is a later pass — do not spend
effort on styling beyond what is needed to verify the data is flowing.

## Core principle: satellite repos describe themselves

The hub never contains a hardcoded list of projects. A repo opts into the portfolio by
containing a `.showcase.yml` file at its root on the default branch. Adding a project to
the site must require **zero edits to this repo**.

### `.showcase.yml` schema (lives in each satellite repo)

```yaml
title: J-Lens                          # required
tagline: One line, ~10 words           # required
description: |                         # optional, a paragraph
  Longer prose shown on the card's expanded view.
tags: [interpretability, pytorch]      # optional; merged with GitHub topics
order: 10                              # optional sort weight, lower = earlier
demo: https://user.github.io/j-lens/   # optional; overrides auto-detected Pages URL
hidden: false                          # optional kill switch
screenshots:                           # optional
  - path: docs/img/hero.png
    alt: Attribution heatmap over a prompt
docs:                                  # optional; PDFs stay in the satellite repo
  - title: J-Lens technical report
    path: paper/j-lens.pdf
```

**Fallback:** if a repo has the GitHub topic `showcase` but no `.showcase.yml`, synthesize
a minimal entry from its GitHub description. Low-friction path for older repos.

## Build pipeline

A single zero-dependency Node script (`build/build.mjs`, Node 20+, native `fetch`) that:

1. Lists my repos via the GitHub API. Skip forks and archived repos.
2. For each, `GET /repos/{owner}/{repo}/contents/.showcase.yml` on the default branch.
   404 means not participating. Presence is the opt-in signal.
3. Parses the YAML. Do not add a YAML dependency for this if a ~60-line parser covering
   the subset above will do; if it gets ugly, `js-yaml` is acceptable.
4. Enriches from the repo object: `html_url`, `description`, `language`, `topics`,
   `stargazers_count`, `pushed_at`, `has_pages`. If `has_pages`, call
   `GET /repos/{owner}/{repo}/pages` for `html_url`. Explicit `demo:` wins over both.
5. Writes `data/projects.json`.
6. Vendors screenshots: fetch the bytes from `raw.githubusercontent.com` and write to
   `assets/shots/{slug}-{n}.png`. Do not hotlink across repos.
7. **Does not copy PDFs.** Emits a live `raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}`
   URL per doc, plus the blob URL and the file size from the contents API. Branch-pinned,
   not SHA-pinned, so the link tracks the source repo.

Auth: read `GITHUB_TOKEN` from env, falling back to `gh auth token` for local runs.
Never hit the API from the browser — unauthenticated visitors get 60 req/hr per IP.

### `data/projects.json` shape

```json
{
  "generated_at": "2026-08-28T00:00:00Z",
  "projects": [
    {
      "slug": "j-lens",
      "title": "J-Lens",
      "tagline": "...",
      "description": "...",
      "repo_url": "https://github.com/OWNER/j-lens",
      "demo_url": "https://OWNER.github.io/j-lens/",
      "language": "Python",
      "tags": ["interpretability"],
      "stars": 0,
      "pushed_at": "2026-07-01T00:00:00Z",
      "order": 10,
      "screenshots": [{ "src": "assets/shots/j-lens-0.png", "alt": "..." }],
      "docs": [
        {
          "title": "J-Lens technical report",
          "raw_url": "https://raw.githubusercontent.com/OWNER/j-lens/main/paper/j-lens.pdf",
          "blob_url": "https://github.com/OWNER/j-lens/blob/main/paper/j-lens.pdf",
          "bytes": 812394
        }
      ]
    }
  ]
}
```

Treat this file as the contract. The frontend is a pure function of it, so I can rewrite
the frontend later without touching any plumbing.

## Frontend

Single `index.html` plus one JS file and one CSS file. No framework, no bundler. It
`fetch`es `data/projects.json` at load and renders cards. Filtering by tag is the only
interactivity worth having. Every card links out — repo, demo, docs.

PDFs: plain `<a href="{raw_url}" download>` links with the file size shown. Note for
later: `raw.githubusercontent.com` sends `Content-Disposition: attachment` and blocks
framing, so an `<iframe>` preview will not work; an in-page preview would require
fetching the bytes and rendering with PDF.js. Out of scope for now.

Use root-relative-free paths (`./assets/...`, `./data/...`) so the site works whether it
is served from the domain root or a `/repo-name/` subpath.

## Deployment

`.github/workflows/build.yml`:

- triggers: `schedule` (nightly), `workflow_dispatch`, `push` to main
- permissions: `contents: read`, `pages: write`, `id-token: write`
- runs the build, then `actions/upload-pages-artifact` + `actions/deploy-pages`
- generated `data/` and `assets/shots/` go into the artifact and are **gitignored** —
  they are build output, not source

Add `.nojekyll` so nothing gets filtered by Jekyll.

If a satellite repo should be able to trigger a rebuild on its own push, that needs a
`repository_dispatch` call with a PAT stored in the satellite. Optional; nightly is
probably enough. Don't build it in milestone 1.

## Build order — do these one at a time and stop between

1. **Discovery only.** Script lists repos, reports which have `.showcase.yml`, prints
   parsed contents to stdout. No files written. Verify against what I expect.
2. **Emit `data/projects.json`.** Full enrichment, PDF URLs, no screenshots yet.
   Validate every emitted URL returns 200.
3. **Minimal `index.html`.** Unstyled or near-unstyled. Confirm every project, demo link,
   and PDF link resolves in a browser.
4. **Screenshot vendoring** into `assets/shots/`.
5. **Wire the Action** and get a live deploy.
6. **Then** design.

## Acceptance test

Add `.showcase.yml` to a repo that has never been mentioned in this one, re-run the
build, and the project appears on the site correctly with no edits to this repo.

## Non-goals

- Hosting demos here. Demos live in their own repos' Pages.
- Copying PDFs into this repo. They are fetched live from source.
- A CMS, a database, or any server.
- Migrating anything off Heroku. Ignore it entirely for now.