import { BrokerToDevice } from '../protobufs.js'


export default (router, broker) => {
  console.log("Installing Publish Command")

  // Encode a B2D-shaped object as a BrokerToDevice and publish it on the
  // connected client's B2D topic: { client, message }
  router.post('/publish', ({ body, protomq: { client, clientId }}, res) => {
    const { message } = body || {}

    if (!client) {
      return res.status(404).json({
        status: "ERROR",
        message: `No client found with id: ${clientId}`
      })
    }
    if (!message || typeof message !== 'object') {
      return res.status(400).json({
        status: "ERROR",
        message: "publish requires a 'message' object (B2D-shaped payload)"
      })
    }

    const topic = Object.keys(client.subscriptions || {})
      .find(t => t.includes('/ws-b2d/'))
    if (!topic) {
      return res.status(400).json({
        status: "ERROR",
        message: `Client "${clientId}" isn't subscribed to a ws-b2d topic`
      })
    }

    let payload
    try {
      payload = BrokerToDevice.encode(BrokerToDevice.fromObject(message)).finish()
    } catch (e) {
      return res.status(400).json({
        status: "ERROR",
        message: `Message is not a valid BrokerToDevice: ${e.message}`
      })
    }

    broker.publish({ topic, payload: Buffer.from(payload) }, err => {
      if (err) {
        return res.status(500).json({ status: "ERROR", message: err.message })
      }
      console.log(`Published on ${topic}:\n  ${JSON.stringify(message)}`)
      res.json({ status: "OK", topic })
    })
  })
}
