import {
  clearAutoresponders,
  deactivateScript,
  setFallbackCheckinEnabled,
} from '../broker/protobuf_autoresponders.js'
import { clearDeliveries } from './deliveries.js'


export default (router, _broker) => {
  console.log("Installing Reset Command")

  // Reset all settings to defaults and clear all data:
  // - remove registered autoresponders
  // - deactivate the active script
  // - re-enable the fallback checkin autoresponder
  // - clear delivery tracker mailboxes
  router.post('/reset', (req, res) => {
    const autoresponders = clearAutoresponders()
    deactivateScript()
    setFallbackCheckinEnabled(true)
    const mailboxes = clearDeliveries()

    console.log(`[Reset API] Cleared ${autoresponders} autoresponder(s), ${mailboxes} mailbox(es)`)
    res.json({ status: 'OK', cleared: { autoresponders, mailboxes } })
  })
}
