import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { TimeWindow } from './timewindow.ts'
export const toolContext = new AsyncLocalStorage<{ window?: TimeWindow; clients: Set<string>; correlationId?: string }>()
export const requestedToolWindow = () => toolContext.getStore()?.window
export const auditClient = (id: string) => { toolContext.getStore()?.clients.add(id) }

export const toolCorrelationId = (): string => toolContext.getStore()?.correlationId || randomUUID()
