// kit-cloud-pilot plugin: records the install for other plugins (kit-cloud's band) in <data dir>/install.json and adds
// /pilot. The work itself is done by the CLI (bin/cloud-pilot.mjs) that Claude runs through its shell; the skill
// (skills/cloud-pilot) names its path and says how. No system-prompt section: for Team and Enterprise accounts the
// built-in security plugin keeps prompt content out of reach of installed plugins, so the skill carries the path.
import type { EngineInterface, Register } from 'claude-code'

export const VERSION = '1.0.0'

const clean = (v: string | undefined) => (v ?? '').trim()
const trimSlash = (p: string) => p.replace(/[\\/]+$/, '')

/** Same folder rule as hub/lib/store.mjs: CLOUD_PILOT_DIR, the older KIT_HUB_DIR, else ~/.claude/cloud-pilot. */
async function dataDir($: EngineInterface): Promise<string> {
  const own = clean(await $.env.get('CLOUD_PILOT_DIR')) || clean(await $.env.get('KIT_HUB_DIR'))
  if (own) return trimSlash(own)
  const home = clean(await $.env.get('USERPROFILE')) || clean(await $.env.get('HOME'))
  return `${trimSlash(home)}/.claude/cloud-pilot`
}

export function cliPath(root: string): string {
  return `${trimSlash(root).replace(/\\/g, '/')}/bin/cloud-pilot.mjs`
}

async function runCli($: EngineInterface, args: string[]): Promise<string> {
  try {
    const r = await $.process.run(['node', cliPath($.plugin.root), ...args], { timeoutMs: 30_000 })
    return (r.stdout || r.stderr).trim() || `exit ${r.exitCode}`
  } catch (err) {
    return `node did not run (${(err as Error).message}). Install Node 18+ and make sure node is on PATH.`
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'pilot', description: 'cloud-pilot: tracked cloud sessions, doctor, help', argumentHint: '[status | doctor | help]' })
      const dir = await dataDir($)
      await $.fs.write(`${dir}/install.json`, JSON.stringify({
        root: $.plugin.root, cli: cliPath($.plugin.root), version: VERSION, updatedMs: await $.clock.now(),
      }, null, 2) + '\n')
    } catch { /* never block a session from starting */ }
    return next(e)
  })

  on('command.run', { command: 'pilot' }, async ($, e) => {
    const verb = String(e.args ?? '').trim().split(/\s+/)[0]?.toLowerCase() || 'status'
    if (verb === 'doctor') return { text: await runCli($, ['doctor']) }
    if (verb === 'help') return { text: await runCli($, ['help']) }
    if (verb === 'status') return { text: await runCli($, ['status']) }
    return { text: 'Usage: /pilot [status | doctor | help]' }
  })
}
