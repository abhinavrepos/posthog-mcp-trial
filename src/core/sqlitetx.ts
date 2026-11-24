import type { DatabaseSync } from 'node:sqlite'

/** Undoes an open transaction after a failed write. SQLite rolls the whole transaction back by itself on some
 * errors (a full disk: "database or disk is full", out of memory, I/O errors), and a ROLLBACK then fails with
 * "cannot rollback - no transaction is active", which used to replace the real reason in logs and on the System
 * page. Call it in a catch block and rethrow the original error. */
export function rollback(db: DatabaseSync): void {
    if (db.isTransaction) db.exec('ROLLBACK')
}
