import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validatePreviewPackage, validateWorkflowSkillReference } from './workflow-preview-package';

/** Local authoring validator only. Runtime reads regular Git blobs at an exact SHA. */
export function validateLocalPreviewPackage(repo: string, reference: unknown): string {
  const ref = validateWorkflowSkillReference(reference);
  const files: Record<string, string> = {};
  let total = 0;
  const walk = (relative: string) => {
    const target = resolve(repo, ref.path, relative);
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error('Package symlinks are forbidden');
    if (stat.isDirectory()) {
      if (relative && !['assets', 'references'].includes(relative)) throw new Error('Invalid package directory');
      const names = readdirSync(target);
      if (names.length > 16) throw new Error('Package file count exceeded');
      for (const name of names) walk(relative ? `${relative}/${name}` : name);
    } else {
      if (!stat.isFile() || (stat.mode & 0o111) || stat.size > 65536 || (total += stat.size) > 262144 || Object.keys(files).length >= 16) throw new Error('Unsafe or oversized package file');
      files[relative] = readFileSync(target, 'utf8');
    }
  };
  // Also reject a symlink in the path prefix, not only inside the package.
  if (lstatSync(resolve(repo, 'skills')).isSymbolicLink()) throw new Error('Package path symlink forbidden');
  walk('');
  return validatePreviewPackage(files).fingerprint;
}
