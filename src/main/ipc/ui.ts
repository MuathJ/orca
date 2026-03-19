import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type { PersistedUIState } from '../../shared/types'

export function registerUIHandlers(store: Store): void {
  ipcMain.handle('ui:get', () => {
    return store.getUI()
  })

  ipcMain.handle('ui:set', (_event, args: Partial<PersistedUIState>) => {
    store.updateUI(args)
  })
}
