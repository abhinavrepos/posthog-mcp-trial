export const shots = [
  { name: 'signin', path: '/replays', signedOut: true },
  { name: 'replays', path: '/replays' },
  { name: 'live', path: '/replays/live' },
  { name: 'surveys', path: '/replays/surveys' },
  { name: 'pinned', path: '/replays/pinned' },
  { name: 'admin', path: '/replays/admin' },
  { name: 'connect', path: '/replays/connect' },
  { name: 'system', path: '/replays/system' },
]
export const tabs = {
  admin: ['People', 'Chat keys', 'Clips', 'Activity'],
  surveys: ['Results', 'Daily activity', 'By client', 'Settings', 'Preview'],
  system: ['Overview', 'Containers', 'Trends', 'Service checks', 'Database'],
}
export const surveyStates = ['running', 'draft', 'stopped']
export function shotName(name, tab, theme, width) {
  return `${name}${tab ? '-' + tab.toLowerCase().replace(/[^a-z0-9]+/g, '-') : ''}-${theme}-${width}.png`
}
