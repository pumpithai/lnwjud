import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { appError, err, ok, type Result } from '@lnwjud/domain';
import { DurableShellTaskIndex } from './durable-shell-task-index.js';
import { DurableShellTaskStore } from './durable-shell-task-store.js';
import { contains } from './workspace-write-scope.js';

export type WriterContainmentKind = 'synchronous_mutation' | 'uncontained_process' | 'contained_process';

export interface ManagedWriterAdmissionLease {
  readonly id: string;
  readonly workspaceRoot?: string;
  /** Call only after the mutation completed and every spawned process was verified terminated. */
  releaseAfterVerifiedTermination(): Promise<void>;
}

/**
 * Reuses the durable shell's single on-disk reservation index across all
 * workspaces. An uncontained process reservation deliberately cannot be
 * reclaimed by PID disappearance; child/orphan zero-activity proof is required.
 */
export class SharedManagedWriterAdmission {
  private readonly index: DurableShellTaskIndex;

  constructor(taskDirectory: string, private readonly rootProvider?: (workspaceId: string) => Promise<string | undefined>) {
    const store = new DurableShellTaskStore(taskDirectory);
    this.index = new DurableShellTaskIndex(taskDirectory, {
      maxConcurrentTasks: 10000,
      inspectTask: (taskId): ReturnType<DurableShellTaskStore['inspectForWriterAdmission']> =>
        store.inspectForWriterAdmission(taskId),
    });
  }

  async resolveWorkspaceRoot(workspaceId: string): Promise<string | undefined> {
    try {
      const root = await this.rootProvider?.(workspaceId);
      return root !== undefined && path.isAbsolute(root) ? await realpath(root) : undefined;
    } catch { return undefined; }
  }

  async resolveMutationRoot(workspaceId: string, paths?: readonly string[]): Promise<string | undefined> {
    if (!paths?.length) return undefined;
    const root = await this.resolveWorkspaceRoot(workspaceId);
    if (root === undefined) return undefined;
    const targets = await Promise.all(paths.map((target) => canonicalMutationPath(root, target)));
    return targets.every((target) => target !== undefined && contains(root, target)) ? root : undefined;
  }

  /**
   * Acquire a short-lived barrier for overlapping canonical workspace roots.
   * Writers without a proven filesystem scope still block every workspace.
   * The caller holds the barrier across its SQLite admission transaction.
   */
  async holdExclusiveProbe(workspaceId: string): Promise<Result<ManagedWriterAdmissionLease>> {
    if (!workspaceId) return err(appError('INVALID_INPUT', 'Workspace lease probe requires a workspace ID'));
    const id = 'workspace-writer-probe-' + randomUUID();
    const requestDigest = createHash('sha256').update(id + ':' + workspaceId).digest('hex');
    const workspaceRoot = await this.resolveWorkspaceRoot(workspaceId);
    const reserved = await this.index.reserve({
      taskId: id,
      requestDigest,
      mutationKind: 'workspace_probe',
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      ownerClientId: 'lnwjud-workspace-writer-fence',
      ownerWorkspaceId: workspaceId,
    });
    if (!reserved.ok) return reserved;
    return ok({
      id,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      releaseAfterVerifiedTermination: (): Promise<void> => this.index.release(id, requestDigest),
    });
  }

  async enter(input: {
    readonly actorClientId: string;
    readonly workspaceId: string;
    readonly kind: WriterContainmentKind;
    readonly nativeReceiptPath?: string;
    readonly paths?: readonly string[];
  }): Promise<Result<ManagedWriterAdmissionLease>> {
    if (!input.actorClientId || !input.workspaceId
      || (input.kind !== 'synchronous_mutation' && input.kind !== 'uncontained_process' && input.kind !== 'contained_process')) {
      return err(appError('INVALID_INPUT', 'Managed writer admission identity is invalid'));
    }
    const id = 'managed-writer-' + randomUUID();
    const digest = createHash('sha256').update(id + ':' + input.actorClientId + ':' + input.workspaceId).digest('hex');
    const workspaceRoot = input.kind === 'synchronous_mutation'
      ? await this.resolveMutationRoot(input.workspaceId, input.paths) : undefined;
    const reserved = await this.index.reserve({
      taskId: id,
      requestDigest: digest,
      mutationKind: input.kind === 'uncontained_process' ? 'opaque_uncontained' : input.kind === 'contained_process' ? 'opaque_contained_process' : 'opaque',
      ...(input.nativeReceiptPath === undefined ? {} : { nativeReceiptPath: input.nativeReceiptPath }),
      ownerClientId: input.actorClientId,
      ownerWorkspaceId: input.workspaceId,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    });
    if (!reserved.ok) return reserved;
    return ok({
      id,
      releaseAfterVerifiedTermination: (): Promise<void> => this.index.release(id, digest),
    });
  }
}

async function canonicalMutationPath(root: string, target: string): Promise<string | undefined> {
  if (typeof target !== 'string' || !target || target.includes('\0')) return undefined;
  const absolute = path.resolve(root, target);
  try { return await realpath(absolute); }
  catch (error: unknown) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return undefined;
    // A dangling symlink is unknown, not a new file under its lexical parent.
    if (await lstat(absolute).then(() => true, () => false)) return undefined;
    const parent = path.dirname(absolute);
    if (parent === absolute) return undefined;
    const canonicalParent = await canonicalMutationPath(root, parent);
    return canonicalParent === undefined ? undefined : path.join(canonicalParent, path.basename(absolute));
  }
}
