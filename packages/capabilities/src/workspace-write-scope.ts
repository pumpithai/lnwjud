import path from 'node:path';

/** Roots are canonical host paths; a missing root is an unbounded writer. */
export function workspaceRootsOverlap(first: string | undefined, second: string | undefined): boolean {
  if (first === undefined || second === undefined) return true;
  return contains(first, second) || contains(second, first);
}

export function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
