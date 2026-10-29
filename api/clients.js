import { map } from 'lodash-es'


export default (router, broker) => {
  console.log("Installing Clients Command")

  // List currently connected clients and their subscriptions (with qos)
  router.get('/clients', (req, res) => {
    const clients = map(broker.clients, ({ id, subscriptions }) => ({
      id,
      subscriptions: map(subscriptions, ({ qos }, topic) => ({ topic, qos })),
    }))

    res.json({ status: 'OK', clients })
  })
}
