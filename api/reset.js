import {
  clearAutoresponders,
  deactivateScript,
  setFallbackCheckinEnabled,
} from '../broker/protobuf_autoresponders.js'
import { getSeq } from '../broker/seq.js'
import { clearDeliveries } from './deliveries.js'


export default (router, broker) => {
  console.log("Installing Reset Command")

  // Reset all settings to defaults and clear all data:
  // - remove registered autoresponders
  // - deactivate the active script
  // - re-enable the fallback checkin autoresponder
  // - clear delivery tracker mailboxes
  // Connected clients are left connected. Returns the current message seq
  // so tests have a starting point for the deliveries that follow.
  router.post('/reset', (req, res) => {
    const autoresponders = clearAutoresponders()
    deactivateScript()
    setFallbackCheckinEnabled(true)
    const mailboxes = clearDeliveries()
    const seq = getSeq()

    console.log(`[Reset API] Cleared ${autoresponders} autoresponder(s), ${mailboxes} mailbox(es) at seq ${seq}`)
    res.json({ status: 'OK', seq, cleared: { autoresponders, mailboxes } })
  })
}
