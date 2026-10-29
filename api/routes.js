import { Router } from 'express'

import enableDisconnect from './disconnect.js'
import enableDeliveries from './deliveries.js'
import enableEcho from './echo.js'
import enablePublish from './publish.js'
import enableScripts from './scripts.js'
import enableAutoresponse from './autoresponse.js'
import enableClients from './clients.js'
import enableReset from './reset.js'
import enableStatus from './status.js'


export default (broker, { ports }) => {
  const router = Router()

  // middleware: log, extract client id, lookup client, store on req
  router.use((req, res, next) => {
    const
      { client: clientId } = req.body || {},
      client = broker.clients?.[clientId]

    console.log(clientId
      ? `[API:${req.url}] for "${clientId}"`
      : `[API:${req.url}]`
    )

    req.protomq = { client, clientId }

    next()
  })

  enableDisconnect(router, broker)
  enableDeliveries(router, broker)
  enableEcho(router, broker)
  enablePublish(router, broker)
  enableScripts(router, broker)
  enableAutoresponse(router, broker)
  enableClients(router, broker)
  enableReset(router, broker)
  enableStatus(router, broker, { ports })

  // rough draft of possible API:
  //
  // router.post('/autoresponse', (req, res) => {
  //   // read expected protobuf message name and configuration
  //   // read expected topic to receive on
  //   // read (optional) response message name/config
  //   // read (optional) response topic to use
  //   // set broker into listen-and-respond mode with these settings
  //   res.json({ response: 'OK' })
  // })

  // router.delete('/autoresponse', (req, res) => {
  //   // clear expected messages and put broker into open mode
  //   res.json({ response: 'OK' })
  // })

  return router
}
