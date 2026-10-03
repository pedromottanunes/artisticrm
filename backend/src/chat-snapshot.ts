import { createHash } from 'node:crypto';

// Revalidate authorization and query current data on every request. Only the
// unchanged response body is omitted; no shared cache of private conversations.
export function chatSnapshot<T extends object>(data: T, revision?: string) {
  const current = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return revision === current
    ? { unchanged: true as const, revision: current }
    : { ...data, revision: current };
}
