import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { getSeq } from '../broker/seq.js'


// the ProtoMQ checkout, regardless of the directory it was started from
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// run a git command, returning trimmed stdout or null on any failure
const git = args => {
  try {
    return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch(e) {
    return null
  }
}

const hashFile = path => {
  try {
    return `sha256:${createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex')}`
  } catch(e) {
    return null
  }
}

const readJSON = path => {
  try {
    return JSON.parse(readFileSync(join(ROOT, path)))
  } catch(e) {
    return null
  }
}

export default (router, broker, { ports }) => {
  console.log("Installing Status Command")

  // computed once: these don't change while the process runs
  const
    startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString(),
    gitStatus = git(['status', '--porcelain']),
    protomq = {
      gitSha: git(['rev-parse', 'HEAD']),
      dirty: gitStatus === null ? null : gitStatus.length > 0,
    },
    protobufs = {
      bundleHash: hashFile('protobufs/bundle.json'),
      // written by `npm run import-protos`
      source: readJSON('protobufs/source.json'),
      v1BundleHash: hashFile('protobufs-v1/bundle.json'),
    }

  // ProtoMQ version, protobuf versions, ports, uptime
  router.get('/status', (req, res) => {
    res.json({
      status: 'OK',
      protomq,
      protobufs,
      ports,
      startedAt,
      uptimeSeconds: process.uptime(),
      seq: getSeq(),
    })
  })
}
