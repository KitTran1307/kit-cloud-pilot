import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { cliPath, promptSection } from './register'

type Seen = { writes: { path: string; text: string }[]; runs: string[][] }

function engine(on: On, env: Record<string, string> = { USERPROFILE: 'C:\\Users\\ann' }, failWrite = false): Seen {
  const seen: Seen = { writes: [], runs: [] }
  on('command.register', () => ({ value: { command: 'pilot' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_800_000_000_000 }))
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('fs.write', (_, e) => {
    if (failWrite) return { deny: 'EACCES' }
    seen.writes.push({ path: String(e.path), text: String(e.text) })
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const { argv } = e as { argv: string[] }
    seen.runs.push([...argv])
    return { value: { exitCode: 0, stdout: `{"ok":true,"verb":"${argv[2]}"}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'engine:base', text: 'base', scope: 'shared' as const }] }))
  return seen
}

test('the CLI path is the plugin root with forward slashes; the prompt section names it', () => {
  expect(cliPath('C:\\Users\\ann\\plugins\\kit-cloud-pilot\\')).toBe('C:/Users/ann/plugins/kit-cloud-pilot/bin/cloud-pilot.mjs')
  expect(cliPath('/opt/pilot')).toBe('/opt/pilot/bin/cloud-pilot.mjs')
  const text = promptSection('/opt/pilot/bin/cloud-pilot.mjs')
  expect(text).toContain('node "/opt/pilot/bin/cloud-pilot.mjs" <command>')
  expect(text).toContain('cloud-pilot skill')
})

test('session start records the install where kit-cloud looks for it', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(seen.writes).toHaveLength(1)
  expect(seen.writes[0]?.path.replace(/\\/g, '/')).toMatch(/Users\/ann\/\.claude\/cloud-pilot\/install\.json$/)
  const rec = JSON.parse(seen.writes[0]?.text ?? '{}')
  expect(rec.cli).toMatch(/bin\/cloud-pilot\.mjs$/)
  expect(typeof rec.version).toBe('string')
})

test('CLOUD_PILOT_DIR, then the older KIT_HUB_DIR, choose the data folder', async ($, on) => {
  const seen = engine(on, { CLOUD_PILOT_DIR: '/data/pilot/', KIT_HUB_DIR: '/data/old', HOME: '/home/ann' })
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(seen.writes[0]?.path.replace(/\\/g, '/')).toMatch(/data\/pilot\/install\.json$/)
})

test('a folder that cannot be written never blocks the session', async ($, on) => {
  engine(on, { HOME: '/home/ann' }, true)
  const started = await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  expect(started.cwd).toBe('/work')
})

test('the system prompt gains one section after the engine\'s own', async ($, on) => {
  engine(on)
  const out = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never)
  expect(out.sections.map(s => s.id)).toEqual(['engine:base', 'kit-cloud-pilot:cli'])
  expect(out.sections[1]?.scope).toBe('session')
})

test('/pilot runs the CLI: status by default, doctor and help; anything else shows usage', async ($, on) => {
  const seen = engine(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  for (const [args, verb] of [['', 'status'], ['doctor', 'doctor'], ['HELP', 'help']] as const) {
    const out = await $.command.run({ command: 'pilot', args } as never)
    expect(JSON.stringify(out)).toContain(`"verb\\":\\"${verb}`)
  }
  expect(seen.runs.every(r => r[0] === 'node' && /cloud-pilot\.mjs$/.test(r[1] ?? ''))).toBe(true)
  expect(JSON.stringify(await $.command.run({ command: 'pilot', args: 'launch' } as never))).toContain('Usage')
})
