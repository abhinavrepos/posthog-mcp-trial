// These are user-visible views. Tabs are clicked by their accessible names, so this
// inventory also works with the original UI where the newer tab wrappers are absent.
export const shots = [
  { name: 'signin', path: '/replays', signedOut: true },
  { name: 'replay-clips', path: '/replays' },
  { name: 'watchlist', path: '/replays/watch' },
  { name: 'live', path: '/replays/live' },
  ...['briefing', 'rescue', 'scorecard', 'task_map', 'pinned'].map(view => ({ name: `dashboards-${view.replace('_', '-')}`, path: `/replays/dashboards?view=${view}` })),
  { name: 'dashboards-flow-time', path: '/replays/dashboards?view=flow_time&task=t_InvoiceExport' },
  { name: 'dashboards-chart', path: '/replays/dashboards/aaaabbbbcccc' },
  { name: 'surveys', path: '/replays/surveys' },
  { name: 'chat', path: '/replays/connect' },
  { name: 'system', path: '/replays/system' },
  { name: 'admin', path: '/replays/admin' },
  { name: 'privacy', path: '/replays/admin/privacy' },
]
export const tabs = {
  watchlist: ['Highlights', 'Clients'],
  system: ['Overview', 'Containers', 'Trends', 'Service checks', 'Database'],
  admin: ['People', 'Client outcomes', 'Chat keys', 'Clips', 'Activity'],
  surveys: ['Results', 'Daily activity', 'By client', 'Settings', 'Preview'],
}
export const surveyStates = ['running', 'draft', 'stopped']
export function shotName(name, tab, theme, width) {
  return `${name}${tab ? '-' + tab.toLowerCase().replace(/[^a-z0-9]+/g, '-') : ''}-${theme}-${width}.png`
}
