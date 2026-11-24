/**
 * A queued reply stays bound to the repository that recorded it, and a state directory that already belongs to one repository
 * cannot switch to another. Two repositories with the same Issue number are both fixtures here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { githubKind } from '../src/sources/github.ts'
import { githubAddress, githubChannel, githubTarget } from '../src/sources/github-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })

const signal = () => new AbortController().signal
const reply = (channel: OutboundMessage['channel']): OutboundMessage => ({ id: 'reply-42', channel, text: 'Confidential status', kind: 'reply' })

describe('repository isolation', () => {
  it('parses the repository of a GitHub URL so an address can name the repository that recorded it', () => {
    expect(githubTarget('https://github.com/acme/widgets/issues/42')).toEqual({ repository: 'acme/widgets', number: 42, pr: false })
    expect(githubTarget('https://api.github.com/repos/acme/widgets/pulls/42')).toEqual({ repository: 'acme/widgets', number: 42, pr: true })
    expect(githubTarget('https://github.com/acme/other/issues/42')).toMatchObject({ repository: 'acme/other', number: 42 })
    expect(githubTarget('https://github.com/acme/widgets/commits/abc')).toBeUndefined()
    expect(githubAddress('https://github.com/acme/other/issues/42', 'acme/widgets')).toBeUndefined()
    expect(githubChannel(42, 'https://github.com/acme/widgets/issues/42').address)
      .toEqual({ number: '42', repository: 'acme/widgets', url: 'https://github.com/acme/widgets/issues/42' })
  })

  it('never posts a queued reply to another repository\'s same-numbered Issue', async () => {
    const first = testDeployment({ repository: 'acme/widgets' })
    const second = testDeployment({ repository: 'acme/gadgets' })
    const message = reply(githubChannel(42, 'https://github.com/acme/widgets/issues/42'))
    // The configured repository changed before the queued reply went out; GitHub still reports acme/widgets as itself.
    const other = new Commands(() => second, {}, signal())
    const otherRun = vi.spyOn(other, 'run').mockImplementation(async (_program, args) =>
      args[1] === 'repos/acme/widgets' ? '"acme/widgets"' : '{}')
    const otherPages = vi.spyOn(other, 'pages')
    expect(await githubKind.channel!.send({ commands: other }, message)).toBe('misdirected')
    // The mismatch is checked against GitHub; the reply is not posted.
    expect(otherRun.mock.calls.map(([, args]) => args)).toEqual([['api', 'repos/acme/widgets', '--jq', '.full_name']])
    expect(otherPages).not.toHaveBeenCalled()
    // Before this record carried a repository, the stored URL alone bound it; an older receipt is refused the same way.
    otherRun.mockClear()
    const legacy = reply({ source: 'github', thread: 'github:42', address: { number: '42', url: 'https://github.com/acme/widgets/issues/42' } })
    expect(await githubKind.channel!.send({ commands: other }, legacy)).toBe('misdirected')
    expect(otherRun.mock.calls.map(([, args]) => args)).toEqual([['api', 'repos/acme/widgets', '--jq', '.full_name']])
    // In the repository that recorded it, the same reply goes to Issue 42.
    const mine = new Commands(() => first, {}, signal())
    vi.spyOn(mine, 'pages').mockResolvedValue([])
    const gh = vi.spyOn(mine, 'gh').mockResolvedValue({})
    expect(await githubKind.channel!.send({ commands: mine }, message)).toBe('sent')
    expect(gh).toHaveBeenCalledWith(['api', 'repos/acme/widgets/issues/42/comments', '--method', 'POST', '-f',
      expect.stringContaining('Confidential status')])
  })

  it('keeps a queued reply after its repository is renamed, which GitHub maps back to the configured repository', async () => {
    // The Source is configured with the canonical name; the queued reply still names the repository's former name.
    const commands = new Commands(() => testDeployment({ repository: 'acme/widgets' }), {}, signal())
    const run = vi.spyOn(commands, 'run').mockImplementation(async (_program, args) =>
      args[1] === 'repos/acme/old' ? '"acme/widgets"' : '{}')
    vi.spyOn(commands, 'pages').mockResolvedValue([])
    const message = reply({ source: 'github', thread: 'github:42',
      address: { number: '42', repository: 'acme/old', url: 'https://github.com/acme/old/issues/42' } })
    expect(await githubKind.channel!.send({ commands }, message)).toBe('sent')
    expect(run).toHaveBeenCalledWith(commands.deployment.github.cli, ['api', 'repos/acme/old', '--jq', '.full_name'])
    // The reply goes to the configured canonical repository, not to a same-numbered Issue of another one.
    expect(run).toHaveBeenCalledWith(commands.deployment.github.cli, ['api', 'repos/acme/widgets/issues/42/comments', '--method',
      'POST', '-f', expect.stringContaining('Confidential status')])
  })

  it('refuses a stored target whose URL names another repository or another number', async () => {
    const commands = new Commands(() => testDeployment({ repository: 'acme/widgets' }), {}, signal())
    const run = vi.spyOn(commands, 'run').mockImplementation(async (_program, args) =>
      args[1]?.startsWith('repos/') ? JSON.stringify(args[1].slice('repos/'.length)) : '{}')
    const pages = vi.spyOn(commands, 'pages')
    const addresses: Record<string, string>[] = [{ number: '42', url: 'https://github.com/acme/gadgets/issues/42' }, // another repository
      { number: '42', url: 'https://github.com/acme/widgets/issues/43' }, // another number
      { number: '42', repository: 'acme/gadgets', url: 'https://github.com/acme/widgets/issues/42' }] // a contradicting record
    for (const address of addresses) {
      expect(await githubKind.channel!.send({ commands }, reply({ source: 'github', thread: 'github:42', address }))).toBe('misdirected')
    }
    expect(run.mock.calls.some(([, args]) => args.includes('--method'))).toBe(false)
    expect(pages).not.toHaveBeenCalled()
  })

  it('drops a misdirected queued reply with a visible reason instead of sending it', async () => {
    h = await startRuntime()
    h.runtime.outbox.send(reply(githubChannel(42, 'https://github.com/acme/gadgets/issues/42')))
    await h.runtime.sendReplies()
    expect(h.runtime.outbox.status('reply-42')).toBe('dropped')
    expect(h.runtime.store.receipts.get('reply-42')).toMatchObject({ dropped: { reason: 'channelOtherRepository' } })
    expect(JSON.stringify(vi.mocked(Commands.prototype.gh).mock.calls)).not.toContain('Confidential status')
  })

  it('refuses to switch the GitHub repository in a state directory that already belongs to one', async () => {
    h = await startRuntime()
    const { settings, store } = h.runtime
    const github = settings.block('source:github')
    const value = github.value as { enabled: boolean; config: Record<string, unknown> }
    await expect(settings.save('source:github', { ...value, config: { ...value.config, repository: 'acme/gadgets' } }, github.revision, 'panel'))
      .rejects.toMatchObject({ code: 'repositorySwitch', values: { repository: 'acme/gadgets', previous: 'acme/widgets' } })
    // The save changed nothing: the Source still watches the repository this state directory records.
    expect(store.settings().sources.github!.config).toMatchObject({ repository: 'acme/widgets' })
    expect(store.get('github-repository')).toBe('acme/widgets')
  })

  it('lets a state directory that belongs to no repository yet set one', async () => {
    h = await startRuntime()
    const { settings, store } = h.runtime
    // A fresh state directory has no recorded repository and is still waiting for setup to resolve one.
    store.delete('github-repository')
    vi.spyOn(h.runtime.setup, 'configured').mockReturnValue(false)
    const github = settings.block('source:github')
    const value = github.value as { enabled: boolean; config: Record<string, unknown> }
    expect(await settings.save('source:github', { ...value, config: { ...value.config, repository: 'acme/gadgets' } }, github.revision, 'panel'))
      .toMatchObject({ saved: true, restarting: true })
    expect(store.settings().sources.github!.config).toMatchObject({ repository: 'acme/gadgets' })
  })
})
