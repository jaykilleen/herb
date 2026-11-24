// What a note says about the element it was left on, and where that element
// came from. Pure functions over the DOM, so they can be tested on their own.
//
// Where the template comes from, best first:
//   1. Herb debug attributes (ReActionView or Herb::Engine debug mode):
//      data-herb-debug-file-relative-path, -line, -column, -erb.
//   2. Rails' annotate_rendered_view_with_filenames comments
//      (<!-- BEGIN app/views/... -->), for apps not rendering with Herb.

export const NOTE_SCHEMA = "agent-note/1"

const MAX_HTML = 1500
const MAX_TEXT = 300

export interface NoteTemplate {
  file: string
  kind: "view" | "partial"
  inferred?: boolean
}

export interface NoteErb {
  file: string | null
  line: number | null
  column: number | null
  code: string | null
  inside?: boolean
}

export interface NoteSource {
  via: "herb" | "rails-annotations" | null
  erb: NoteErb | null
  templates: NoteTemplate[]
}

export interface NoteElement {
  selector: string
  tag: string
  id: string | null
  classes: string[]
  text: string
  html: string
  rect: { x: number; y: number; width: number; height: number }
  styles: Record<string, string>
}

export interface Note {
  schema: string
  note: string
  page: { url: string; path: string; title: string }
  // The first element the note is about, and where it came from.
  element: NoteElement
  source: NoteSource
  // Every element the note is about, in the order they were picked, each with
  // its own source. The first is the same as `element` and `source`.
  elements: Array<NoteElement & { source: NoteSource }>
  viewport: { width: number; height: number; dpr: number }
  sent_at: string
}

// A note about one element, or several picked together.
export function buildNote(target: Element | Element[], text: string): Note {
  const targets = Array.isArray(target) ? target : [target]

  if (targets.length === 0) throw new Error("A note needs at least one element.")

  const elements = targets.map(element => ({ ...describeElement(element), source: sourceFor(element) }))
  const { source, ...first } = elements[0]

  return {
    schema: NOTE_SCHEMA,
    note: text.trim(),
    page: { url: location.href, path: location.pathname, title: document.title },
    element: first,
    source,
    elements,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    sent_at: new Date().toISOString(),
  }
}

export function describeElement(element: Element): NoteElement {
  const rect = element.getBoundingClientRect()
  const html = element as HTMLElement

  return {
    selector: cssPath(element),
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    classes: [...element.classList],
    text: squish(html.innerText || element.textContent || "").slice(0, MAX_TEXT),
    html: element.outerHTML.slice(0, MAX_HTML),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    styles: pickStyles(element),
  }
}

// The template trail for an element, innermost first: the exact ERB tag that
// printed it (when the element is ERB output), then each partial and view
// that wraps it.
export function sourceFor(element: Element): NoteSource {
  const herb = herbTrail(element)

  if (herb.templates.length || herb.erb) return { via: "herb", ...herb }

  const comments = commentTrail(element)

  if (comments.length) return { via: "rails-annotations", erb: null, templates: comments }

  return { via: null, erb: null, templates: [] }
}

function herbTrail(element: Element): { erb: NoteErb | null; templates: NoteTemplate[] } {
  const templates: NoteTemplate[] = []
  let erb: NoteErb | null = null

  const push = (file: string, kind: NoteTemplate["kind"], inferred: boolean) => {
    const last = templates[templates.length - 1]

    if (!last || last.file !== file) templates.push(inferred ? { file, kind, inferred: true } : { file, kind })
  }

  for (let node: Element | null = element; node; node = node.parentElement) {
    const path = node.getAttribute("data-herb-debug-file-relative-path")

    if (!path) {
      // A view is marked on its first top-level element only ("attach to
      // parent"), so later top-level elements of the same view carry no
      // marker. Borrow it from the nearest earlier sibling that has one.
      const view = precedingViewMarker(node)

      if (view) push(view, "view", true)

      continue
    }

    const type = node.getAttribute("data-herb-debug-outline-type")

    if (!erb && type === "erb-output") {
      erb = erbFrom(node)

      continue
    }

    if (type === "partial" || type === "view") push(path, type, false)
  }

  // An element that is not ERB output itself may still contain the ERB that
  // drew its content (a <span> wrapping <%= name %>). ERB output wrappers are
  // display: contents, so the pointer never lands on one directly.
  if (!erb) {
    const inner = element.querySelector('[data-herb-debug-outline-type="erb-output"]')

    if (inner) erb = { ...erbFrom(inner), inside: true }
  }

  return { erb, templates }
}

function erbFrom(node: Element): NoteErb {
  return {
    file: node.getAttribute("data-herb-debug-file-relative-path"),
    line: intAttribute(node, "data-herb-debug-line"),
    column: intAttribute(node, "data-herb-debug-column"),
    code: node.getAttribute("data-herb-debug-erb"),
  }
}

function precedingViewMarker(node: Element): string | null {
  for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
    if (
      sibling.getAttribute("data-herb-debug-outline-type") === "view" &&
      sibling.getAttribute("data-herb-debug-attach-to-parent") === "true"
    ) {
      return sibling.getAttribute("data-herb-debug-file-relative-path")
    }
  }

  return null
}

// Rails wraps each template in <!-- BEGIN path --> ... <!-- END path -->.
// Walk the document's comments up to the element: a BEGIN whose END has not
// been passed yet is a template that encloses it.
function commentTrail(element: Element): NoteTemplate[] {
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT)
  const open: string[] = []
  let comment: Node | null

  while ((comment = walker.nextNode())) {
    if (element.compareDocumentPosition(comment) & Node.DOCUMENT_POSITION_FOLLOWING) break

    const match = (comment as Comment).data.trim().match(/^(BEGIN|END) (.+)$/)

    if (!match) continue

    if (match[1] === "BEGIN") {
      open.push(match[2])
    } else {
      const index = open.lastIndexOf(match[2])

      if (index >= 0) open.splice(index, 1)
    }
  }

  return open.reverse().map(file => ({ file: relative(file), kind: file.includes("/_") ? "partial" : "view" }))
}

function relative(file: string): string {
  const at = file.indexOf("app/views/")

  return at >= 0 ? file.slice(at) : file
}

function intAttribute(node: Element, name: string): number | null {
  const value = parseInt(node.getAttribute(name) ?? "", 10)

  return Number.isNaN(value) ? null : value
}

function squish(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function pickStyles(element: Element): Record<string, string> {
  const style = getComputedStyle(element)

  return {
    color: style.color,
    background: style.backgroundColor,
    font: `${style.fontWeight} ${style.fontSize} ${style.fontFamily.split(",")[0]}`,
    padding: style.padding,
    margin: style.margin,
    display: style.display,
  }
}

// A short, stable CSS path that stops at the nearest id.
export function cssPath(element: Element): string {
  const parts: string[] = []

  for (let node: Element | null = element; node && parts.length < 6; node = node.parentElement) {
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`)
      break
    }

    let part = node.tagName.toLowerCase()
    const classes = [...node.classList].filter(name => !name.includes(":") && !name.includes("[")).slice(0, 2)

    if (classes.length) part += "." + classes.map(name => CSS.escape(name)).join(".")

    const current = node
    const parent: Element | null = node.parentElement

    if (parent) {
      const same = [...parent.children].filter(child => child.tagName === current.tagName)

      if (same.length > 1) part += `:nth-of-type(${same.indexOf(current) + 1})`
    }

    parts.unshift(part)
  }

  return parts.join(" > ")
}

// Where a note points, in one short line: the ERB tag if there is one, else the
// innermost template.
export function describeSource(source: NoteSource): string | null {
  if (source.erb?.file) return source.erb.line ? `${source.erb.file}:${source.erb.line}` : source.erb.file

  return source.templates[0]?.file ?? null
}
