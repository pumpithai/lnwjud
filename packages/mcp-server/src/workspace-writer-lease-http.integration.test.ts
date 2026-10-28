import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SharedManagedWriterAdmission, SqliteWorkspaceWriterLease } from '@lnwjud/capabilities';
import { FileService } from '@lnwjud/application';
import { AtomicFileWriter } from '../../filesystem/src/atomic-writer.js';
import type { Workspace, WorkspaceRepository } from '../../workspace/src/index.js';
import { describe, expect, it } from 'vitest';
import { startMcpHttp, type McpHttpServerHandle } from './http.js';
import { workspaceWriterLeaseProofSchema } from './tools/schemas.js';

describe('workspace writer lease HTTP contract', () => {
  it.each(['modern', 'legacy'] as const)('%s keeps disjoint projects usable during a real file write and rejects overlapping leases', async (protocol) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'lnwjud-parallel-http-')));
    const clients: Client[] = [];
    const handles: McpHttpServerHandle[] = [];
    let releaseWrite: () => void = () => {};
    let writing: () => void = () => {};
    const paused = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const entered = new Promise<void>((resolve) => { writing = resolve; });
    let pendingWrite: Promise<unknown> | undefined;
    try {
      const workspaces: Workspace[] = ['a', 'b', 'a/child'].map((name) => ({
        id: name, displayName: name, rootPath: path.join(root, name), realRootPath: path.join(root, name), createdAt: new Date(0).toISOString(),
      }));
      await Promise.all(workspaces.map((workspace) => mkdir(workspace.rootPath, { recursive: true })));
      const repository: WorkspaceRepository = {
        async list() { return workspaces; }, async get(id) { return workspaces.find((workspace) => workspace.id === id) ?? null; },
        async insert() {}, async delete() {},
      };
      const gate = new SharedManagedWriterAdmission(path.join(root, 'tasks'), async (id) => (await repository.get(id))?.realRootPath);
      const lease = new SqliteWorkspaceWriterLease(path.join(root, 'leases.sqlite'), Date.now, gate);
      const atomic = new AtomicFileWriter();
      const file = new FileService(repository, undefined, undefined, {
        writerAdmission: gate,
        writer: { async write(target, content, options) {
          if (target === path.join(root, 'a', 'probe.txt')) { writing(); await paused; }
          return atomic.write(target, content, options);
        } },
      });
      for (const name of ['one', 'two']) {
        const handle = await startMcpHttp({ port: 0, services: { workspaceWriterLease: lease, file },
          actor: { clientId: name, clientName: name }, authorizationModeProvider: () => 'full_bypass' });
        handles.push(handle);
        const client = new Client({ name, version: '1' }, { versionNegotiation: { mode: protocol === 'modern' ? { pin: '2026-07-28' } : 'legacy' } });
        clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(handle.endpoint));
      }
      const [one, two] = clients;
      if (!one || !two) throw new Error('Missing clients');
      const acquired = await one.callTool({ name: 'workspace_writer_lease_acquire', arguments: { workspaceId: 'a', ttlSeconds: 120 } });
      const proof = workspaceWriterLeaseProofSchema.parse(acquired.structuredContent);
      pendingWrite = one.callTool({ name: 'write_file', arguments: { workspaceId: 'a', writerLease: proof, path: path.join(root, 'a', 'probe.txt'), content: 'project A' } });
      await entered;
      const independent = await two.callTool({ name: 'workspace_writer_lease_acquire', arguments: { workspaceId: 'b', ttlSeconds: 120 } });
      expect(independent.isError).not.toBe(true);
      const proofB = workspaceWriterLeaseProofSchema.parse(independent.structuredContent);
      const outside = await two.callTool({ name: 'write_file', arguments: { workspaceId: 'b', writerLease: proofB, path: path.join(root, 'a', 'escape.txt'), content: 'must not write' } });
      expect(outside).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
      const unknown = await two.callTool({ name: 'shell', arguments: { workspaceId: 'b', writerLease: proofB, operation: 'run', executable: process.execPath, arguments: ['-e', 'process.exit(0)'], cwd: path.join(root, 'b') } });
      expect(unknown).toMatchObject({ isError: true, structuredContent: { error: { code: 'CONFLICT' } } });
      expect((await two.callTool({ name: 'write_file', arguments: { workspaceId: 'b', writerLease: proofB, path: path.join(root, 'b', 'probe.txt'), content: 'project B' } })).isError).not.toBe(true);
      expect(await readFile(path.join(root, 'b', 'probe.txt'), 'utf8')).toBe('project B');
      expect((await two.callTool({ name: 'workspace_writer_lease_release', arguments: { workspaceId: 'b', writerLease: proofB } })).structuredContent).toEqual({ released: true });
      expect((await two.callTool({ name: 'workspace_writer_lease_acquire', arguments: { workspaceId: 'a/child', ttlSeconds: 120 } })).isError).toBe(true);
      releaseWrite();
      expect(await pendingWrite).not.toHaveProperty('isError', true);
      expect(await readFile(path.join(root, 'a', 'probe.txt'), 'utf8')).toBe('project A');
      expect((await one.callTool({ name: 'workspace_writer_lease_release', arguments: { workspaceId: 'a', writerLease: proof } })).structuredContent).toEqual({ released: true });
      const next = await two.callTool({ name: 'workspace_writer_lease_acquire', arguments: { workspaceId: 'a/child', ttlSeconds: 120 } });
      expect(next.isError).not.toBe(true);
      const nextProof = workspaceWriterLeaseProofSchema.parse(next.structuredContent);
      expect((await two.callTool({ name: 'workspace_writer_lease_release', arguments: { workspaceId: 'a/child', writerLease: nextProof } })).structuredContent).toEqual({ released: true });
    } finally {
      releaseWrite();
      await pendingWrite?.catch(() => undefined);
      await Promise.allSettled(clients.map((client) => client.close()));
      await Promise.allSettled(handles.map((handle) => handle.close()));
      await rm(root, { recursive: true, force: true });
    }
  }, 15000);

  it('recovers lost proof on the same modern stateless endpoint without weakening the fence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-stateless-recovery-'));
    let handle: McpHttpServerHandle | undefined;
    const clients: Client[] = [];
    let time = 100_000;
    try {
      const lease = new SqliteWorkspaceWriterLease(path.join(root, 'leases.sqlite'), () => time);
      handle = await startMcpHttp({
        port: 0, services: { workspaceWriterLease: lease },
        actor: { clientId: 'shared-endpoint', clientName: 'shared-endpoint' },
        authorizationModeProvider: () => 'full_bypass',
      });
      for (const name of ['original-chat', 'resumed-chat']) {
        const client = new Client({ name, version: '1' }, {
          versionNegotiation: { mode: { pin: '2026-07-28' } },
        });
        clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(handle.endpoint));
      }
      const [first, resumed] = clients;
      if (first === undefined || resumed === undefined) throw new Error('Missing clients');
      const target = { workspaceId: 'workspace-a', ttlSeconds: 600 };
      const acquired = await first.callTool({ name: 'workspace_writer_lease_acquire', arguments: target });
      expect(acquired.isError).not.toBe(true);
      const oldProof = workspaceWriterLeaseProofSchema.parse(acquired.structuredContent);
      const recovery = { ...target, recoverAbandoned: true, userConfirmed: true };
      expect((await resumed.callTool({ name: 'workspace_writer_lease_acquire', arguments: recovery })).isError).toBe(true);
      time += 61_000;
      expect((await resumed.callTool({ name: 'workspace_writer_lease_acquire', arguments: target })).isError).toBe(true);
      expect((await resumed.callTool({ name: 'workspace_writer_lease_acquire', arguments: { ...recovery, userConfirmed: false } })).isError).toBe(true);
      const recovered = await resumed.callTool({ name: 'workspace_writer_lease_acquire', arguments: recovery });
      expect(recovered.isError).not.toBe(true);
      const proof = workspaceWriterLeaseProofSchema.parse(recovered.structuredContent);
      expect(proof.generation).toBe(oldProof.generation + 1);
      for (const name of ['workspace_writer_lease_renew', 'workspace_writer_lease_release']) {
        expect((await first.callTool({ name, arguments: { ...target, writerLease: oldProof } })).isError).toBe(true);
      }
      const released = await resumed.callTool({ name: 'workspace_writer_lease_release', arguments: { ...target, writerLease: proof } });
      expect(released.structuredContent).toEqual({ released: true });
      expect(await lease.inspect(target.workspaceId)).toMatchObject({ ok: true, value: { state: 'unleased', activeCalls: 0 } });
      const next = await first.callTool({ name: 'workspace_writer_lease_acquire', arguments: target });
      expect(next.isError).not.toBe(true);
      const nextProof = workspaceWriterLeaseProofSchema.parse(next.structuredContent);
      expect(nextProof.generation).toBe(proof.generation + 1);
      expect((await first.callTool({ name: 'workspace_writer_lease_release', arguments: { ...target, writerLease: nextProof } })).structuredContent).toEqual({ released: true });
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await handle?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['modern', 'legacy'] as const)('%s releases with schema-valid output and admits an independent writer immediately', async (protocol) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lnwjud-lease-http-'));
    const handles: McpHttpServerHandle[] = [];
    const clients: Client[] = [];
    try {
      const lease = new SqliteWorkspaceWriterLease(path.join(root, 'leases.sqlite'));
      for (const name of ['first', 'second']) {
        const handle = await startMcpHttp({
          port: 0, services: { workspaceWriterLease: lease },
          actor: { clientId: name, clientName: name },
          authorizationModeProvider: () => 'full_bypass',
        });
        handles.push(handle);
        const client = new Client({ name, version: '1' }, {
          versionNegotiation: { mode: protocol === 'modern' ? { pin: '2026-07-28' } : 'legacy' },
        });
        clients.push(client);
        await client.connect(new StreamableHTTPClientTransport(handle.endpoint));
      }
      const [first, second] = clients;
      if (first === undefined || second === undefined) throw new Error('Missing fixture client');
      const target = { workspaceId: 'workspace-a' };
      const acquired = await first.callTool({ name: 'workspace_writer_lease_acquire', arguments: { ...target, ttlSeconds: 120 } });
      expect(acquired.isError).not.toBe(true);
      const proof = workspaceWriterLeaseProofSchema.parse(acquired.structuredContent);
      expect((await first.callTool({ name: 'workspace_writer_lease_renew', arguments: { ...target, writerLease: proof } })).isError).not.toBe(true);
      const released = await first.callTool({ name: 'workspace_writer_lease_release', arguments: { ...target, writerLease: proof } });
      expect(released.isError).not.toBe(true);
      expect(released.structuredContent).toEqual({ released: true });
      expect(await lease.inspect(target.workspaceId)).toMatchObject({ ok: true, value: { state: 'unleased', activeCalls: 0 } });
      const next = await second.callTool({ name: 'workspace_writer_lease_acquire', arguments: { ...target, ttlSeconds: 30 } });
      expect(next.isError).not.toBe(true);
      const nextProof = workspaceWriterLeaseProofSchema.parse(next.structuredContent);
      expect(nextProof.generation).toBe(proof.generation + 1);
      expect((await second.callTool({ name: 'workspace_writer_lease_release', arguments: { ...target, writerLease: nextProof } })).isError).not.toBe(true);
    } finally {
      await Promise.allSettled(clients.map((client) => client.close()));
      await Promise.allSettled(handles.map((handle) => handle.close()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
