export interface DictionaryEntry {
  key: string
  lemma: string
  edition: string
  isCet6: boolean
}

/**
 * Future CET-6 integration boundary.
 *
 * Target vocabulary may only be injected into the chat prompt through an
 * explicit practice setting. A full dictionary or a learning review must
 * never be appended to conversational context.
 */
export interface DictionaryRepository {
  readonly installed: boolean
  findByLemmas(lemmas: string[]): Map<string, DictionaryEntry>
}

export class UnavailableDictionaryRepository implements DictionaryRepository {
  readonly installed = false

  findByLemmas(_lemmas: string[]): Map<string, DictionaryEntry> {
    return new Map()
  }
}
