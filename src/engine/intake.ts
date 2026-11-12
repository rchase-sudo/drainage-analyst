import { relayer } from './importer'
import type { Drawing } from './types'

const EX = /(^|[^A-Z])(E|EX|EXIST|EXISTING|EXST|EXG)([^A-Z]|$)/
const PR = /(^|[^A-Z])(P|PR|PROP|PROPOSED|NEW)([^A-Z]|$)/
const NAME_POST = /PROP|\bPOST\b|SITE.?DEV|GRADING|DRAINAGE|DEVELOP|LAYOUT|DESIGN|\bPR\b|\bPH\s?\d/
const NAME_PRE = /EXIST|\bEX\b|\bEC\b|\bPRE\b|SURVEY|TOPO|\bGIS\b|LIDAR|BOUNDARY|\bBASE\b/

export interface Sorted { pre: Drawing[]; post: Drawing[]; notes: string[] }

/**
 * Sorts a dropped set of drawings into existing / proposed without asking: by file name first, then by what the
 * layers hold. A single drawing carrying both existing and proposed layers is used for both conditions.
 * Drawings arrive imported as 'pre'; the ones used as proposed are re-read with proposed layer roles.
 */
export function sortDrawings(ds: Drawing[]): Sorted {
  const info = ds.map((d) => {
    let e = 0, p = 0
    const cache = new Map<string, number>()
    for (const en of d.ents) {
      let k = cache.get(en.layer)
      if (k == null) {
        const n = en.layer.toUpperCase().replace(/[_.|$]/g, ' ')
        k = /^HC/.test(n) ? 0 : PR.test(n) && !EX.test(n) ? 2 : EX.test(n) && !PR.test(n) ? 1 : 0
        cache.set(en.layer, k)
      }
      if (k === 1) e++
      else if (k === 2) p++
    }
    const name = d.fileName.toUpperCase().replace(/\.(DXF|XML)$/, '').replace(/[_\-.]+/g, ' ')
    const nPre = NAME_PRE.test(name), nPost = NAME_POST.test(name)
    const pShare = p / Math.max(1, e + p)
    const says: 'pre' | 'post' | null = nPre && !nPost ? 'pre' : nPost && !nPre ? 'post' : null
    const surfaceOnly = !!d.tin && !d.ents.length
    return { d, e, p, pShare, side: surfaceOnly ? 'pre' : says ?? (pShare > 0.2 ? 'post' : 'pre') as 'pre' | 'post' }
  })
  const pre = info.filter((x) => x.side === 'pre')
  const post = info.filter((x) => x.side === 'post')
  const notes: string[] = []
  const both: string[] = []
  // one combined drawing (or no explicit counterpart): use it for both conditions
  if (!pre.length) for (const x of post) if (x.e > 20) { pre.push(x); both.push(x.d.fileName) }
  if (!post.length) for (const x of info) if (x.side === 'pre' && x.p > 20 && x.pShare > 0.08) { post.push(x); both.push(x.d.fileName) }
  const names = (xs: typeof info) => xs.map((x) => x.d.fileName).filter((n) => !both.includes(n)).join(', ')
  if (names(pre)) notes.push(`Existing: ${names(pre)}`)
  if (names(post)) notes.push(`Proposed: ${names(post)}`)
  if (both.length) notes.push(`Both conditions from the existing and proposed layers of: ${both.join(', ')}`)
  return { pre: pre.map((x) => x.d), post: post.map((x) => relayer(x.d, 'post')), notes }
}
