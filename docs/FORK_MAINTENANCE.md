# Maintain this fork

This fork keeps the tested writer-lease fixes on `dev`. The baseline is upstream
commit `1a0453ed0ef1de4cdf9ce1ba9edee8da0de8426b` (5.8.7).
The existing `main` branch is preserved; it is not the verified development build.
Retain the original MIT license, copyright notice and third-party notices.

## Remotes

```sh
git remote -v
```

`origin` must point to `https://github.com/pumpithai/lnwjud.git`.
`upstream` must fetch from `https://github.com/engasnm111/lnwjud.git`.
The maintained checkout disables upstream pushes with
`git config remote.upstream.pushurl disabled://upstream-read-only` and sets
`git config remote.pushDefault origin`. These are local Git settings; apply them
when creating a new checkout. Work on `dev` under the repository's AGENTS.md rules.

## Review an upstream update

Start with a clean working tree. Fetching does not change the running app:

```sh
git fetch --no-tags upstream
git log --oneline dev..upstream/main
git diff --stat dev upstream/main
git diff dev upstream/main -- packages/capabilities/src/workspace-writer-lease.ts packages/capabilities/src/shared-managed-writer-admission.ts packages/capabilities/src/durable-shell-task-index.ts packages/mcp-server/src/tool-registry.ts
```

Review the changes and upstream release notes before choosing a commit to import.
Record the current `dev` SHA before merging. Do not reset the fork to upstream or
use the GitHub Sync Fork discard option: that can remove the local fixes.
When ready, merge the reviewed upstream commit into `dev`, resolve conflicts while
retaining the invariants below, and run the checks. Do not update the installed
runtime merely because fetch or merge succeeded.

## Verify before publishing or installing

Use the repository's Node 24 toolchain and pinned pnpm version:

```sh
NODE_OPTIONS=--conditions=development corepack pnpm@10.15.0 exec vitest run packages/capabilities/src/shared-managed-writer-admission.test.ts packages/capabilities/src/durable-shell-task-index.test.ts packages/capabilities/src/durable-shell-task-store.test.ts packages/capabilities/src/workspace-writer-lease.test.ts packages/application/src/file-service-write.test.ts packages/application/src/file-service.test.ts packages/application/src/process-service.test.ts packages/application/src/git-service.test.ts packages/mcp-server/src/tool-registry.test.ts packages/mcp-server/src/workspace-writer-lease-http.integration.test.ts tests/integration/process-writer-admission.test.ts
corepack pnpm@10.15.0 --filter @lnwjud/capabilities build
corepack pnpm@10.15.0 --filter @lnwjud/application build
corepack pnpm@10.15.0 --filter @lnwjud/mcp-server build
corepack pnpm@10.15.0 --filter @lnwjud/cli build
corepack pnpm@10.15.0 --filter @lnwjud/desktop build
git diff --check
```

Required behavior:

- Release returns `{released: true}` and status becomes `unleased`; independent
  reacquisition succeeds immediately.
- Explicit same-client idle recovery works in a shared stateless HTTP session
  after the 60-second grace and revokes old proofs.
- Separate canonical registered project roots admit concurrent bounded file work.
  Overlapping roots, symlink aliases, unknown writers and outside-root mutations
  remain fenced. A shell's `cwd` is not filesystem containment.
- The installed archive's main bundle matches the tested build byte-for-byte.

Run the platform's existing release gates as well when preparing a release.
Keep a rollback artifact, wait for other writers to finish, and acquire a short
deployment fence before restarting a development runtime. Test its real MCP
lifecycle after installation. Do not restore a runtime database for an app-only rollback.

## Update ownership

`apps/desktop/electron-builder.yml` publishes to `pumpithai/lnwjud`, so future
fork packages use the fork's update feed. This change does not publish a release
or retrofit an already installed package's update metadata. Linux unpacked/DEB
builds have no supported electron-updater install path; update them manually.
Do not install an upstream binary over the fork without verifying these fixes.
No scheduled upstream sync, automatic merge, release or deployment is configured
by this guide. Inspect inherited workflows before enabling them in the fork.
