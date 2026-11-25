// Only errors constructed by Signal policy code may pass through verbatim. Upstream JSON cannot
// forge this marker; all other returned errors are handled like thrown execution failures.
const publicErrors = new WeakSet<object>()
export function publicToolError<T extends object>(result: T): T { publicErrors.add(result); return result }
export const isPublicToolError = (result: unknown): boolean => !!result && typeof result==='object' && publicErrors.has(result)
