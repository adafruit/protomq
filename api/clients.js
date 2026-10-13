import { getClientsState } from '../broker/listeners.js'


export default (router, broker) => {
  console.log("Installing Clients Command")

  // List connected clients and their subscriptions,
  // same data that is published on the state/clients topic
  router.get('/clients', (req, res) => {
    res.json({ status: 'OK', clients: getClientsState(broker) })
  })
}
