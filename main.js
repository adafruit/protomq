/** Runs the ProtoMQ application, which is:
- a collection of input protobufs, compiled to a json specification
- an MQTT broker that speaks the provided protobufs
- a web server that provides:
  - WebSocket access to the MQTT broker
  - an HTTP API to control the behavior of the MQTT broker
  - a graphical web frontend that:
    - shows the broker's status, connections, subscriptions, etc
    - shows all of the protobufs available
    - allows manually creating protobufs and sending them to the broker
*/


// Steps:
// [x] ensure a protobuf bundle file is present, provide import instructions if not
// [x] ensure built js files are present, provide Vite build instructions if not
// [x] start the mqtt broker
// [x] open the mqtt broker to websocket connections
// start the web server
import fs from 'fs'

import { createBroker } from './broker/index.js'
import { createWebApp } from './api/index.js'


// Read a `--name=value` or `--name value` CLI flag. Also supports the npm
// config passthrough form (`npm run start --name="value"`), which npm exposes
// as process.env.npm_config_<name_with_underscores>.
const parseArg = (argv, name) => {
  const flag = `--${name}`
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1)
    }
    // flag present without a value: return '' so callers can tell it apart
    // from an absent flag (null)
    if (arg === flag) {
      const nextArg = argv[i + 1]
      return nextArg && !nextArg.startsWith('--') ? nextArg : ''
    }
  }

  const npmConfigArg = process.env[`npm_config_${name.replaceAll('-', '_')}`]
  if (npmConfigArg && String(npmConfigArg).trim()) {
    return String(npmConfigArg).trim()
  }

  return null
}

// Resolve a port: CLI flag > env var > default
const parsePort = (argv, flagName, envName, defaultPort) => {
  const flagValue = parseArg(argv, flagName)
  if (flagValue === '') {
    throw new Error(`--${flagName} requires a value (e.g. --${flagName}=${defaultPort})`)
  }
  const raw = flagValue ?? process.env[envName] ?? defaultPort
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${raw}" for --${flagName} / ${envName} (expected an integer 1-65535)`)
  }
  return port
}

async function main() {
  const
    argv = process.argv.slice(2),
    requestedActiveScript = parseArg(argv, 'active-script')

  let ports
  try {
    ports = {
      mqtt: parsePort(argv, 'mqtt-port', 'PROTOMQ_MQTT_PORT', 1884),
      ws: parsePort(argv, 'ws-port', 'PROTOMQ_WS_PORT', 8888),
      http: parsePort(argv, 'http-port', 'PROTOMQ_HTTP_PORT', 5173),
    }
  } catch(e) {
    console.error(e.message)
    process.exitCode = 1
    return
  }

  // ensure protobufs are ready
  if(!fs.existsSync('protobufs/bundle.json')) {
    console.error("No protobuf bundle found!\nDid you run `npm run import-protos`?")
    return
  }

  // ensure frontend application is built
  if(!fs.existsSync('dist/index.html')) {
    console.error("No web app files found!\nDid you run `npm run build-web`?")
    return
  }

  const broker = await createBroker({ activeScriptName: requestedActiveScript, ports })

  const webServer = createWebApp(broker, { ports })
}

main()
