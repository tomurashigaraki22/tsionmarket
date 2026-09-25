import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |ED25519 )?PRIVATE KEY-----/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/],
  ['stripe-secret', /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{30,}\b/],
]
// Match literal assignments only. Environment interpolation (Compose/GitHub)
// and schema declarations are not credentials and should not trip the scanner.
const onSwitchEnvAssignment =
  /\bONSWITCH_(?:SANDBOX|LIVE)_SERVICE_KEY[ \t]*=[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'`#]+))/g
const onSwitchCodeAssignment = /\bONSWITCH_(?:SANDBOX|LIVE)_SERVICE_KEY[ \t]*:[ \t]*(["'])(.*?)\1/g
const knownPlaceholders =
  /(?:example|placeholder|change[_ -]?me|not[_ -]?real|your[_ -]?key|test[_ -]?secret|dummy|replace[_ -]?me)/i

function isOnSwitchCredential(value) {
  return value.length >= 24 && !value.includes('$') && !knownPlaceholders.test(value)
}

export function detectedSecretKinds(source) {
  const findings = patterns.filter(([, pattern]) => pattern.test(source)).map(([name]) => name)
  for (const match of source.matchAll(onSwitchEnvAssignment)) {
    const value = match[1] ?? match[2] ?? match[3] ?? ''
    if (isOnSwitchCredential(value)) findings.push('onswitch-service-key')
  }
  for (const match of source.matchAll(onSwitchCodeAssignment)) {
    if (isOnSwitchCredential(match[2] ?? '')) findings.push('onswitch-service-key')
  }
  return [...new Set(findings)]
}

export function scanTrackedWorkspace() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter((file) => !file.startsWith('node_modules/') && file !== 'package-lock.json')
  const findings = []

  for (const file of files) {
    let contents
    try {
      contents = readFileSync(file)
    } catch {
      continue
    }
    if (contents.includes(0)) continue
    const kinds = detectedSecretKinds(contents.toString('utf8'))
    for (const kind of kinds) findings.push({ file: path.normalize(file), kind })
  }
  return findings
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const findings = scanTrackedWorkspace()
  if (findings.length > 0) {
    for (const finding of findings) process.stderr.write(`Potential ${finding.kind} in ${finding.file}\n`)
    process.stderr.write('Remove the credential and rotate it; values are intentionally not printed.\n')
    process.exitCode = 1
  } else {
    process.stdout.write('Secret scan passed; no supported credential patterns found.\n')
  }
}
