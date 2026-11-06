import { copyFileSync, renameSync, rmSync } from 'node:fs'

/** Moves a finished file to `target`, which appears complete or not at all. A plain rename fails with
 * EXDEV between folders mounted separately, as .cache/ and clips/ are in the container, so the file is
 * copied next to the target first. */
export function moveFile(source: string, target: string): void {
    const tmp = `${target}.tmp-${process.pid}`
    try {
        copyFileSync(source, tmp)
        renameSync(tmp, target)
    } finally {
        rmSync(tmp, { force: true })
    }
    rmSync(source, { force: true })
}
