import {
  clearAutoresponders,
  deactivateScript,
  setFallbackCheckinEnabled,
} from '../broker/protobuf_autoresponders.js'
import { clearDeliveries } from './deliveries.js'


export default (router, broker) => {
  console.log("Installing Reset Command")

  // Reset all settings to defaults and clear all data:
  // - remove registered autoresponders
  // - deactivate the active script
  // - re-enable the fallback checkin autoresponder
  // - clear delivery tracker mailboxes
  router.post('/reset', async (req, res) => {
    const autoresponders = clearAutoresponders()
    deactivateScript()
    setFallbackCheckinEnabled(true)
    const clients = Object.values(broker.clients || {})

    await Promise.all(clients.map(client => new Promise(resolve => {
      if (client.closed) return resolve()
      client.close(resolve)
    })))
    const mailboxes = clearDeliveries()

    console.log(`[Reset API] Cleared ${autoresponders} autoresponder(s), ${mailboxes} mailbox(es), disconnected ${clients.length} client(s)`)
    res.json({ status: 'OK', cleared: { autoresponders, mailboxes, clients: clients.length } })
  })
}
