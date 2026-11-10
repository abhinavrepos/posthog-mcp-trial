// The task history: placeholder until Agent 1 fills it in (see taskstypes.ts for the contract).
import type { FlowTime, FlowTimeParams, IngestStatus, Task, TaskMap, TaskMapParams } from './taskstypes.ts'

export async function taskMap(_p: TaskMapParams): Promise<TaskMap> { throw new Error('not built yet') }
export async function flowTime(_p: FlowTimeParams): Promise<FlowTime> { throw new Error('not built yet') }
export function findTasks(_query: string, _limit = 10): Task[] { return [] }
export function ingestStatus(): IngestStatus { return { days_done: 0, first_day: null, last_day: null, behind_days: 0, attempts: 0, last_run: null, last_error: null, running: false } }
export function startTaskHistory(): void {}
