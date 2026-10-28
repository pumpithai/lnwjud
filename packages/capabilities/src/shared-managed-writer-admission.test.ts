import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DurableShellTaskStore } from './durable-shell-task-store.js';
import { SharedManagedWriterAdmission } from './shared-managed-writer-admission.js';
import { SqliteWorkspaceWriterLease } from './workspace-writer-lease.js';

describe('global managed writer admission', () => {
  it('fences overlapping registered leases and unleased alias calls while independent projects keep working', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-overlap-leases-')));
    try {
      const a = path.join(root, 'a'), b = path.join(root, 'b'), child = path.join(a, 'child');
      await Promise.all([mkdir(child, { recursive: true }), mkdir(b)]);
      const roots: Record<string, string> = { a, b, child, alias: a };
      const gate = new SharedManagedWriterAdmission(path.join(root, 'tasks'), async (id) => roots[id]);
      const lease = new SqliteWorkspaceWriterLease(path.join(root, 'leases.sqlite'), Date.now, gate);
      const first = await lease.acquire('a', 'one', 'session', 120);
      if (!first.ok) throw new Error('First lease failed');
      const separate = await lease.acquire('b', 'two', 'session', 120);
      expect(separate).toMatchObject({ ok: true });
      for (const id of ['alias', 'child']) {
        expect(await lease.acquire(id, 'other', 'other', 120)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
        expect(await lease.begin(id, 'other', 'other', 'alias-call')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      }
      expect(await lease.release('a', 'one', 'session', first.value)).toMatchObject({ ok: true });
      expect(await lease.begin('child', 'other', 'other', 'child-call', undefined, [path.join(child, 'file.txt')])).toMatchObject({ ok: true });
      expect(await lease.acquire('a', 'one', 'session', 120)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await lease.end('child', 'child-call', 0);
      const after = await lease.acquire('a', 'one', 'session', 120);
      expect(after).toMatchObject({ ok: true });
      if (after.ok) await lease.release('a', 'one', 'session', after.value);
      if (separate.ok) await lease.release('b', 'two', 'session', separate.value);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('admits disjoint workspace probes during a bounded file mutation, but blocks overlapping roots and unknown writers', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-scoped-admission-')));
    try {
      const a = path.join(root, 'a'), b = path.join(root, 'ab'), child = path.join(a, 'child');
      await Promise.all([mkdir(child, { recursive: true }), mkdir(b)]);
      const roots: Record<string, string> = { a, b, child, alias: a };
      const gate = new SharedManagedWriterAdmission(path.join(root, 'tasks'), async (id) => roots[id]);
      const writer = await gate.enter({ actorClientId: 'writer', workspaceId: 'a', kind: 'synchronous_mutation', paths: [path.join(a, 'new.txt')] });
      if (!writer.ok) throw new Error('Writer not admitted');
      const independent = await gate.holdExclusiveProbe('b');
      expect(independent).toMatchObject({ ok: true });
      if (independent.ok) await independent.value.releaseAfterVerifiedTermination();
      for (const id of ['a', 'alias', 'child', 'unknown']) {
        expect(await gate.holdExclusiveProbe(id)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      }
      await writer.value.releaseAfterVerifiedTermination();
      const unbounded = await gate.enter({ actorClientId: 'process', workspaceId: 'a', kind: 'uncontained_process' });
      if (!unbounded.ok) throw new Error('Process not admitted');
      expect(await gate.holdExclusiveProbe('b')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await unbounded.value.releaseAfterVerifiedTermination();
      const resumed = await gate.holdExclusiveProbe('b');
      expect(resumed).toMatchObject({ ok: true });
      if (resumed.ok) await resumed.value.releaseAfterVerifiedTermination();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('treats symlink escapes and missing target information as global, and canonicalizes workspace aliases', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-scope-alias-')));
    try {
      const a = path.join(root, 'a'), b = path.join(root, 'b');
      await Promise.all([mkdir(a), mkdir(b)]);
      await symlink(b, path.join(a, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      await symlink(a, path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
      const roots: Record<string, string> = { a, b, alias: path.join(root, 'alias') };
      const gate = new SharedManagedWriterAdmission(path.join(root, 'tasks'), async (id) => roots[id]);
      for (const paths of [undefined, [path.join(a, 'escape', 'new.txt')]]) {
        const writer = await gate.enter({ actorClientId: 'writer', workspaceId: 'a', kind: 'synchronous_mutation', ...(paths === undefined ? {} : { paths }) });
        if (!writer.ok) throw new Error('Writer not admitted');
        expect(await gate.holdExclusiveProbe('b')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
        await writer.value.releaseAfterVerifiedTermination();
      }
      const alias = await gate.holdExclusiveProbe('alias');
      if (!alias.ok) throw new Error('Alias probe not admitted');
      expect(await gate.holdExclusiveProbe('a')).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await alias.value.releaseAfterVerifiedTermination();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses to grant/release workspace lease while a separate managed writer is active', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-global-lease-admission-'));
    try {
      const gate = new SharedManagedWriterAdmission(path.join(root, 'background-tasks'));
      const lease = new SqliteWorkspaceWriterLease(path.join(root, 'writer-leases.sqlite'), Date.now, gate);
      const blocker = await gate.enter({ actorClientId: 'other-client', workspaceId: 'other-workspace', kind: 'synchronous_mutation' });
      expect(blocker.ok).toBe(true);
      if (!blocker.ok) return;
      expect(await lease.acquire('first-workspace', 'owner', 'session', 60))
        .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await blocker.value.releaseAfterVerifiedTermination();
      const acquired = await lease.acquire('first-workspace', 'owner', 'session', 60);
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;
      const active = await gate.enter({ actorClientId: 'other-client', workspaceId: 'other-workspace', kind: 'synchronous_mutation' });
      expect(active.ok).toBe(true);
      if (!active.ok) return;
      expect(await lease.release('first-workspace', 'owner', 'session', acquired.value))
        .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await active.value.releaseAfterVerifiedTermination();
      expect(await lease.release('first-workspace', 'owner', 'session', acquired.value))
        .toMatchObject({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  }, 20000);

  it('refuses same-client idle recovery until the global managed writer is released', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-recover-managed-writer-'));
    try {
      let time = 100_000;
      const gate = new SharedManagedWriterAdmission(path.join(root, 'background-tasks'));
      const lease = new SqliteWorkspaceWriterLease(path.join(root, 'leases.sqlite'), () => time, gate);
      expect(await lease.acquire('workspace', 'owner', 'old-session', 600)).toMatchObject({ ok: true });
      const blocker = await gate.enter({ actorClientId: 'separate-client', workspaceId: 'other-workspace', kind: 'synchronous_mutation' });
      if (!blocker.ok) throw new Error('global writer not admitted');
      time += 61_000;
      expect(await lease.acquire('workspace', 'owner', 'new-session', 600, true))
        .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await blocker.value.releaseAfterVerifiedTermination();
      expect(await lease.acquire('workspace', 'owner', 'new-session', 600, true))
        .toMatchObject({ ok: true, value: { generation: 2 } });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  });

  it('excludes repository import against even a different workspace synchronous file writer', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-import-global-admission-')));
    try {
      const gate = new SharedManagedWriterAdmission(root);
      const store = new DurableShellTaskStore(root);
      const entered = await gate.enter({ actorClientId: 'file-client', workspaceId: 'other-workspace', kind: 'synchronous_mutation' });
      expect(entered).toMatchObject({ ok: true });
      if (!entered.ok) throw new Error('admission failed');
      const start = {
        taskId: 'import-test',
        executable: process.execPath, arguments: ['-e', 'process.exit(0)'],
        cwd: root, timeoutSeconds: process.env.CI ? 110 : 15,
        mutationKind: 'repository_import' as const,
        maxOutputBytes: 1000, includeStdout: false, includeStderr: false,
        owner: { clientId: 'other-client', sessionId: 'other', workspaceId: 'import-workspace' },
      };
      expect(await store.launch(start)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
      await entered.value.releaseAfterVerifiedTermination();
      expect(await store.launch(start)).toMatchObject({ ok: true });
      await expect.poll(async (): Promise<string> => {
        const observed = await store.snapshot(start.taskId);
        return observed.ok ? String(observed.value.state) : 'unverified';
      }, { timeout: process.env.CI ? 90000 : 12000 }).toBe('completed');
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  }, process.env.CI ? 130000 : 25000);

  it('an uncontained writer keeps its reservation until an explicit verified-release operation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-import-uncontained-'));
    try {
      const gate = new SharedManagedWriterAdmission(root);
      const writer = await gate.enter({ actorClientId: 'direct-process', workspaceId: 'different-workspace', kind: 'uncontained_process' });
      expect(writer.ok).toBe(true);
      const store = new DurableShellTaskStore(root);
      const launch = {
        taskId: 'import-while-opaque', mutationKind: 'repository_import' as const,
        executable: process.execPath, arguments: ['-e', 'process.exit(0)'],
        cwd: root, timeoutSeconds: 10, maxOutputBytes: 1000, includeStdout: false, includeStderr: false,
        owner: { clientId: 'import', sessionId: 'import', workspaceId: 'import-workspace' },
      };
      expect(await store.launch(launch)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    }
  });
});
