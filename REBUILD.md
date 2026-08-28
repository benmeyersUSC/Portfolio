# Rebuilding the hub

The site rebuilds nightly at 07:17 UTC. Pushing a satellite repo does **not**
trigger it — the build only runs from this repo.

To rebuild now:

```sh
gh workflow run "Build and deploy" -R benmeyersUSC/Portfolio
```

Each run re-scans every satellite, so it picks up changes anywhere.

Watch it:

```sh
gh run watch -R benmeyersUSC/Portfolio $(gh run list -R benmeyersUSC/Portfolio -L1 --json databaseId -q '.[0].databaseId')
```
