import { compact, filter, find, forEach, keys, map, pick } from 'lodash-es'

import { decodeByTopic } from "../protobufs.js"


export default (router, broker) => {
  console.log("Installing Deliveries Tracker")

  // Install Route Handlers
  // begin tracking all message traffic to/from a client id. Idempotent: an
  // already-tracked client keeps its mailbox (emptied), so there is never an
  // instant where a client is untracked and its traffic would be dropped.
  router.post('/track_deliveries', addDeliveryTracker)
  // return all message traffic since track_deliveries to/from a client id, and
  // empty the mailbox. The mailbox itself SURVIVES the read — see the note on
  // sortDeliveries about why deleting it loses packets.
  router.post('/dump_deliveries', dumpDeliveryTracker)
  // stop tracking a client id and discard its mailbox
  router.post('/untrack_deliveries', removeDeliveryTracker)

  // Install Subscription Handler
  // Watch all message traffic for tracked deliveries
  broker.subscribe('#', sortDeliveries(broker))
}

const
  IGNORED_TOPICS_PREFIXES = [ "$SYS/", "state/clients" ],

  topicIsIgnored = topic =>
    find(IGNORED_TOPICS_PREFIXES, prefix => topic.startsWith(prefix)),

  deliveries = {},

  // Empty a mailbox IN PLACE and hand back what was in it. Callers must never
  // `delete deliveries[clientId]` on a live tracker: sortDeliveries drops any
  // packet that arrives while the key is absent (see the `?.` below), and the
  // gap between a delete and its recreate spans an HTTP round trip for API
  // callers. Truncating the arrays is synchronous, so no packet can slip
  // through mid-drain.
  drainMailbox = mailbox => {
    const drained = { inbox: mailbox.inbox, outbox: mailbox.outbox }
    mailbox.inbox = []
    mailbox.outbox = []
    return drained
  },

  addDeliveryTracker = ({ protomq: { clientId }}, res) => {
    // Re-tracking is a reset, not an error: arming a watch means "give me a
    // fresh mailbox from here on", and the caller must be able to ask for that
    // without the client's traffic going untracked in the meantime.
    const existing = deliveries[clientId]
    if(existing) {
      drainMailbox(existing)
      res.json({ status: "OK", reused: true })
      return
    }

    // initialize a mailbox for it
    deliveries[clientId] = { inbox: [], outbox: [] }
    // install publish handlers for this client
    res.json({ status: "OK" })
  },

  // dumpDeliveryTracker = protomqApi((req, res, { clientId }) => {
  dumpDeliveryTracker = ({ protomq: { clientId }}, res) => {
    // look up mailbox for it and map to response
    const clientDeliveries = deliveries[clientId]
    // error if no mailbox found for client
    if(!clientDeliveries) {
      console.error(`Deliveries not tracked for ${clientId}`)
      res.json({ status: 'ERROR', message: `No mailbox initialized for: ${clientId}.` })
      return
    }

    // empty the mailbox but keep tracking the client
    res.json({ status: "OK", deliveries: drainMailbox(clientDeliveries) })
  },

  removeDeliveryTracker = ({ protomq: { clientId }}, res) => {
    if(!deliveries[clientId]) {
      res.json({ status: 'ERROR', message: `No mailbox initialized for: ${clientId}.` })
      return
    }

    delete deliveries[clientId]
    res.json({ status: "OK" })
  },

  sortDeliveries = broker => (packet, callback) => {
    const { topic, clientId } = packet

    if(topicIsIgnored(topic)) { callback(); return }

    // Decode by topic shape (V1 +/wprsnpr/# and V2 ws-b2d/ws-d2b alike);
    // fall back to the raw payload when it isn't a recognized protobuf topic.
    const decoded = decodeByTopic(topic, packet.payload)
    const trackablePacket = { topic, payload: decoded ? decoded.message : packet.payload }

    // If the publishing client has an outbox, track it. An untracked client is
    // a silent drop, and this is the only record of the packet the API can ever
    // serve — so mailboxes are emptied, never deleted, while a watch is live.
    deliveries[clientId]?.outbox.push(trackablePacket)

    // find all tracked clients subscribed to this topic
    const
      trackedIds = keys(deliveries),
      trackedClients = compact(map(trackedIds, clientId => broker.clients[clientId])),
      hitClients = filter(trackedClients, client => find(keys(client.subscriptions), subTopic => subTopic === topic))

    // push it into their inboxes
    forEach(hitClients, client => deliveries[client.id].inbox.push(trackablePacket))
    callback()
  }
