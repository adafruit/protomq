// Broker-wide message sequence number. Incremented once per tracked
// (non-$SYS, non-state) publish and never reset, so tests can use the
// value returned by POST /api/reset as a starting point.
let _seq = 0

export const
  nextSeq = () => ++_seq,
  getSeq = () => _seq
