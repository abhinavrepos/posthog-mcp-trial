import { EventEmitter } from 'node:events'
export type Stored = { type: 'stored'; days: string[]; kinds: ('day' | 'cleanup' | 'performance' | 'aggregate')[] }
// Local bus: the owner forwards worker notifications to every long-lived reader.
export const ingestMessages = new EventEmitter()
export const stored = (message: Stored) => ingestMessages.emit('stored', message)
