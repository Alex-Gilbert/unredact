// @ts-check
/** JSDoc type definitions — the data contract layer for all modules. */

/**
 * @typedef {Object} Font
 * @property {string} id
 * @property {string} name
 * @property {boolean} available
 */

/**
 * @typedef {Object} Segment
 * @property {string} text
 */

/**
 * @typedef {Object} AnalysisFont
 * @property {string} id
 * @property {string} name
 * @property {number} size
 */

/**
 * @typedef {Object} AnalysisGap
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/**
 * @typedef {Object} AnalysisLine
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

/**
 * @typedef {Object} Analysis
 * @property {AnalysisFont} font
 * @property {number} [offset_x]
 * @property {number} [offset_y]
 * @property {AnalysisGap} gap
 * @property {AnalysisLine} line
 * @property {Segment[]} segments
 */

/**
 * @typedef {Object} Overrides
 * @property {string} fontId
 * @property {number} fontSize
 * @property {number} offsetX
 * @property {number} offsetY
 * @property {number} gapWidth
 * @property {string} leftText
 * @property {string} rightText
 */

/**
 * @typedef {Object} Solution
 * @property {string} text
 * @property {string} fontName
 * @property {number} fontSize
 */

/**
 * @typedef {Object} Redaction
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 * @property {number} page
 * @property {'unanalyzed'|'analyzing'|'analyzed'|'solved'|'error'} status
 * @property {Analysis|null} analysis
 * @property {Solution|null} solution
 * @property {string|null} preview
 * @property {Overrides} [overrides]
 */

/**
 * @typedef {Object} AssocEntry
 * @property {string} person_id
 * @property {string} match_type
 * @property {number} tier
 */

/**
 * @typedef {Object} Person
 * @property {string} name
 * @property {string} category
 */

/**
 * @typedef {Object} AssociatesData
 * @property {Object<string, AssocEntry[]>} names
 * @property {Object<string, Person>} persons
 * @property {string[]} [victim_names]
 * @property {Set<string>} [victim_set]
 */

/**
 * @typedef {Object} AppState
 * @property {string|null} docId
 * @property {number} pageCount
 * @property {number} currentPage
 * @property {Object<string, Redaction>} redactions
 * @property {string|null} activeRedaction
 * @property {Font[]} fonts
 * @property {boolean} fontsReady
 * @property {number} zoom
 * @property {number} panX
 * @property {number} panY
 * @property {AssociatesData|null} associates
 */

export {};
