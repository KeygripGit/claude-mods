export type Tab = 'overview' | 'fields' | 'edits' | 'schema' | 'verify' | 'notes' | 'preview'

declare module 'claude-code' {
  interface PluginState {
    'workorder-pane': {
      view: 'queue' | 'order'
      selected: number | null
      tab: Tab
      includeSuperseded: boolean
      checked: number[]
      tick: number
      slice: number
      keyPrompt: boolean
      previewMode: 'live' | 'proposed'
    }
  }
}
