import type { Sql } from './db.js';
import { DomainError, type User } from './types.js';

// Held until commit: disabling/resetting an account cannot race a business mutation.
export async function lockActor(tx: Sql, user: User, exclusive = false) {
  const current = (
    await tx.query<User>(`SELECT * FROM users WHERE id=$1 FOR ${exclusive ? 'UPDATE' : 'SHARE'}`, [
      user.id,
    ])
  ).rows[0];
  if (!current?.active || current.auth_version !== user.auth_version)
    throw new DomainError('UNAUTHENTICATED', 'Acesso revogado. Entre novamente.', 401);
  if (current.must_change_password)
    throw new DomainError('PASSWORD_CHANGE_REQUIRED', 'Altere sua senha para continuar.', 403);
  return current;
}
