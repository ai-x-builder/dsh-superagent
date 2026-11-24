/** GitHub outbound channel: posts issue/PR comments and review thread replies under the agent account. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError, type Commands } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { githubAddress, githubPage, githubTarget } from './github-trigger.ts'

const CommentSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), in_reply_to_id: z.number().nullish(), user: z.looseObject({ login: z.string() }).nullish(),
})
/** True when an issue is permanently deleted (410) or locked (403); 404 is retried because it can indicate temporary permission loss on a private repo. */
const gone = (error: unknown): boolean => error instanceof CliError
  && (error.code === 410 || (error.code === 403 && /locked/i.test(error.message)))
const missing = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410)
/** A repository name safe to name in an API path; stored addresses are our own, but one could be malformed. */
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
/**
 * True when `stored` names the configured repository. A repository renamed on GitHub keeps stored addresses that use its
 * former name, so a name mismatch is checked against GitHub, which redirects the old name to the renamed repository.
 * A deleted or unreadable old repository is treated as another repository; other failures are retried rather than
 * dropping a reply that GitHub might still deliver.
 */
async function sameRepository(commands: Commands, stored: string): Promise<boolean> {
  const { repository } = commands.deployment
  if (sameName(stored, repository)) return true
  if (!repositoryName.test(stored)) return false
  try {
    const response = await commands.gh<{ full_name?: unknown } | null>(['api', `repos/${stored}`])
    const name = response?.full_name
    return typeof name === 'string' && sameName(name, repository)
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}
/**
 * Posts a comment or review-thread reply with an embedded HTML marker so retries do not create duplicate comments.
 * A reply whose stored address names another repository is never sent to the configured repository's Issue or PR with the
 * same number: it settles as `misdirected`, which the Outbox records as `channelOtherRepository`.
 */
export async function sendGithub(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone' | 'misdirected'> {
  const { commands } = host
  const { github } = commands.deployment
  const number = Number(message.channel.address.number)
  if (!number) throw new Error('Missing GitHub reply target')
  const { address } = message.channel
  // Older receipts may carry only the URL; both forms name the repository that recorded the reply.
  const target = address.url ? githubTarget(address.url) : undefined
  const belongs = new Map<string, boolean>()
  const bound = async (stored: string | undefined): Promise<boolean> => {
    if (stored === undefined) return true
    if (!belongs.has(stored)) belongs.set(stored, await sameRepository(commands, stored))
    return belongs.get(stored)!
  }
  if (!await bound(address.repository)) return 'misdirected'
  if (address.url && (!target || target.number !== number || !await bound(target.repository))) return 'misdirected'
  try {
    let rootId: number | undefined
    if (target?.pr && target.discussion !== undefined) {
      // Fall back to a top-level PR comment if the target inline review comment was deleted.
      const source = await commands.api(CommentSchema, `pulls/comments/${target.discussion}`)
        .catch((error: unknown) => { if (missing(error)) return undefined; throw error })
      rootId = source ? source.in_reply_to_id ?? source.id : undefined
    }
    const path = rootId === undefined ? `issues/${number}/comments` : `pulls/${number}/comments`
    const marker = `<!-- dsh-superagent:${message.id} -->`
    const mine = (comment: z.infer<typeof CommentSchema>) => sameName(comment.user?.login ?? '', github.login)
      && (rootId === undefined || comment.in_reply_to_id === rootId) && (comment.body ?? '').includes(marker)
    if ((await commands.pages(CommentSchema, path)).some(mine)) return 'sent'
    const endpoint = rootId === undefined ? path : `${path}/${rootId}/replies`
    await commands.api(z.unknown(), endpoint, '--method', 'POST', '-f', `body=${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
export function githubLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const number = address.number ?? ''
  const repository = address.repository || links.repository
  const review = !!repository && !!githubAddress(address.url ?? '', repository)?.discussion
  return { url: address.url ?? (repository ? githubPage(repository, Number(number)) : ''),
    label: review ? { zh: `GitHub #${number} 的 review 讨论`, en: `Review discussion on GitHub #${number}` }
      : { zh: `GitHub #${number}`, en: `GitHub #${number}` } }
}
