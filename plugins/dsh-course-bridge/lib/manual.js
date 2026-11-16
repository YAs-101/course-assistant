/**
 * dsh-course-bridge: reading the per-subject manual that dsh-video-coursemap
 * keeps in <outputDir>/.state/manuals/<subject>.md.
 *
 * The manual is a single Markdown file whose sections are separated by the
 * literal delimiter "\n\n---\n\n" (see coursemap appendVideo). The first
 * section is the generated 学科总览; every following section starts with an
 * H2 heading that is the video title.
 *
 * @module dsh-course-bridge/lib/manual
 */

/** The exact delimiter coursemap writes between sections. */
export const SEGMENT_DELIMITER = '\n\n---\n\n'

/**
 * Split a manual into sections.
 * @param text - manual Markdown source.
 * @returns the raw sections, in file order (never empty for a non-empty text).
 */
export function splitManual(text) {
  const s = String(text === undefined || text === null ? '' : text)
  if (s.trim() === '') return []
  return s.split(SEGMENT_DELIMITER)
}

/**
 * The H2 heading that opens a section, or "" when it does not start with one.
 * @param segment - one section of a manual.
 */
export function headingOf(segment) {
  const body = String(segment === undefined || segment === null ? '' : segment).trim()
  if (body === '') return ''
  const first = body.split('\n')[0].trim()
  const m = /^##\s+(.+)$/.exec(first)
  return m ? m[1].trim() : ''
}

/**
 * Fold a heading or title for tolerant comparison: drop the leading hashes,
 * then drop every whitespace, punctuation, and symbol character.
 * @param value - heading or title.
 */
export function normalizeTitle(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/^#+\s*/, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase()
}

/**
 * Locate the section that belongs to one video.
 *
 * Matching is tiered so an LLM-rewritten heading still resolves while a
 * genuinely different video never does: exact text first, then a
 * punctuation/whitespace-insensitive comparison, then a bounded containment
 * check that only fires for reasonably long and similarly sized titles
 * (so "DSH" cannot swallow "DSH 进阶").
 *
 * @param text - manual Markdown source.
 * @param title - the video title as recorded in state.json.
 * @returns match details; section is "" when nothing matched.
 */
export function extractSection(text, title) {
  const segments = splitManual(text)
  const target = String(title === undefined || title === null ? '' : title).trim()
  if (!target) return { found: false, section: '', how: 'empty-title', segments: segments.length }

  for (const segment of segments) {
    if (headingOf(segment) === target) return { found: true, section: segment.trim(), how: 'exact', segments: segments.length }
  }

  const wanted = normalizeTitle(target)
  if (wanted === '') return { found: false, section: '', how: 'unmatchable-title', segments: segments.length }

  for (const segment of segments) {
    if (normalizeTitle(headingOf(segment)) === wanted) {
      return { found: true, section: segment.trim(), how: 'normalized', segments: segments.length }
    }
  }

  if (wanted.length >= 10) {
    for (const segment of segments) {
      const heading = normalizeTitle(headingOf(segment))
      if (heading === '') continue
      const shorter = Math.min(heading.length, wanted.length)
      const longer = Math.max(heading.length, wanted.length)
      if (longer === 0 || shorter / longer < 0.8) continue
      if (heading.includes(wanted) || wanted.includes(heading)) {
        return { found: true, section: segment.trim(), how: 'contains', segments: segments.length }
      }
    }
  }

  return { found: false, section: '', how: 'miss', segments: segments.length }
}
