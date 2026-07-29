import { BrokerToDevice } from '../protobufs.js'
import {
  setWakeCheckinResponse,
  getWakeCheckinResponses,
  removeWakeCheckinResponse,
  clearWakeCheckinResponses,
} from '../broker/protobuf_autoresponders.js'

// Capability fields shared with the static checkin fallback
// (handleV2CheckinFallback). Kept here so a registered wake response reports the
// same board capabilities as a plain checkin.
const CHECKIN_CAPABILITIES = {
  response: 'R_OK',
  totalGpioPins: 30,
  totalAnalogPins: 4,
  referenceVoltage: 2.5,
}

export default (router, _broker) => {
  console.log("Installing Wake-Checkin Command")

  // Register a persistent "wake response" for a device that is being deep-slept.
  // The marquee editor calls this at deep-sleep time; the broker replays it on
  // every checkin (re-adds the display + sends it back to sleep) so the device
  // keeps cycling. Re-registering overwrites it; DELETE /api/wake-checkin clears
  // it. Body: { user, device, displayAdd?, sleepConfig?, sleepEnabled? }.
  router.post('/wake-checkin', (req, res) => {
    const { user, device, displayAdd, sleepConfig, sleepEnabled } = req.body || {}

    if (!user || typeof user !== 'string' || !device || typeof device !== 'string') {
      return res.status(400).json({
        status: "ERROR",
        message: "wake-checkin requires 'user' and 'device' strings"
      })
    }

    const response = {
      checkin: {
        response: {
          ...CHECKIN_CAPABILITIES,
          componentAdds: { displayAdds: displayAdd ? [displayAdd] : [] },
          sleepEnabled: sleepEnabled !== false,
          ...(sleepConfig ? { sleepConfig } : {}),
        }
      }
    }

    try {
      // Validate at registration so a malformed display/sleep payload fails fast
      // rather than at checkin time (when there's no HTTP caller to tell).
      BrokerToDevice.encode(BrokerToDevice.fromObject(response)).finish()
    } catch (e) {
      return res.status(400).json({
        status: "ERROR",
        message: `Wake response is not a valid BrokerToDevice: ${e.message}`
      })
    }

    const key = `${user}/${device}`
    setWakeCheckinResponse(key, response)

    console.log(
      `Wake-checkin registered: key="${key}"` +
      `\n  response: ${JSON.stringify(response)}`
    )

    res.json({ status: "OK", key, count: getWakeCheckinResponses().length })
  })

  // List all registered wake responses.
  router.get('/wake-checkin', (_req, res) => {
    res.json({ status: "OK", wakeCheckins: getWakeCheckinResponses() })
  })

  // Remove a single registration by "{user}/{device}" key. The key contains a
  // slash, so it's taken from the body rather than a path param.
  router.delete('/wake-checkin', (req, res) => {
    const { user, device } = req.body || {}
    if (user && device) {
      const removed = removeWakeCheckinResponse(`${user}/${device}`)
      console.log(`Wake-checkin removed: key="${user}/${device}" (${removed})`)
      return res.json({ status: "OK", removed: removed ? 1 : 0 })
    }
    const removed = clearWakeCheckinResponses()
    console.log(`Wake-checkin cleared (${removed} removed)`)
    res.json({ status: "OK", removed })
  })
}
