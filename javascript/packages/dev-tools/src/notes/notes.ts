import notesStyles from "./notes.css"

import { buildNote, cssPath, describeSource, sourceFor } from "./source.js"

import type { Note } from "./source.js"

// Notes: leave a note on one or more elements for whoever works on the
// templates next, usually an AI coding agent.
//
//   Hold Alt            outline the element under the pointer with its template
//   Alt + click         select it (numbered); again to unselect. Repeat for more.
//   Alt + right-click   open the note box for the selection (or just this element)
//   Ctrl+Enter          send.  Esc closes the box, or clears the selection.
//
// The note goes to the dev server, which keeps it in .herb/notes/notes.jsonl
// for `herb notes` (and whatever agent is watching). When the note is closed,
// its reply comes back here.
//
// The UI lives in a shadow root, so the page's CSS cannot reach it and its CSS
// cannot reach the page. The transport is passed in, so this file knows nothing
// about sockets.

export interface NoteSummary {
  id: string
  note: string
  status: "open" | "done"
  reply: string | null
  path: string | null
  file: string | null
  line: number | null
  elements?: number
  received_at: string | null
  done_at: string | null
}

export interface NotesTransport {
  send(note: Note): Promise<NoteSummary>
}

const RECENT = 5

export class Notes {
  private root: ShadowRoot
  private host: HTMLElement
  private highlight: HTMLElement
  private tag: HTMLElement
  private marks: HTMLElement
  private box: HTMLElement
  private heading: HTMLElement
  private where: HTMLElement
  private textarea: HTMLTextAreaElement
  private status: HTMLElement
  private recent: HTMLElement
  private recentList: HTMLElement
  private notice: HTMLElement
  private noticeText: HTMLElement
  private noticeTimer: ReturnType<typeof setTimeout> | null = null
  private isArmed = false
  private isOpen = false
  private selected: Element[] = []
  private known = new Map<string, NoteSummary>()
  private listeners: Array<[EventTarget, string, EventListener, boolean | AddEventListenerOptions | undefined]> = []
  private repositionQueued = false

  constructor(private transport: NotesTransport) {
    this.host = document.createElement("div")
    this.host.setAttribute("data-herb-notes", "")

    this.root = this.host.attachShadow({ mode: "open" })
    const style = document.createElement("style")
    style.textContent = notesStyles

    this.highlight = element("div", "highlight")
    this.tag = element("div", "tag")
    this.highlight.append(this.tag)
    this.marks = element("div", "marks")

    this.box = element("div", "box")
    const top = element("div", "top")
    this.heading = element("div", "heading")
    const dismiss = element("button", "dismiss", "✕")
    dismiss.setAttribute("aria-label", "Close")
    dismiss.title = "Close (Esc)"
    top.append(this.heading, dismiss)

    this.where = element("div", "where")
    this.textarea = document.createElement("textarea")
    this.textarea.placeholder = "What should change here?"
    this.status = element("div", "status")

    const hint = element("span", "hint", "Ctrl+Enter to send, Esc to close")
    const cancel = element("button", "cancel", "Cancel")
    const send = element("button", "send", "Send note")
    const buttons = element("div", "buttons")
    buttons.append(cancel, send)

    const row = element("div", "row")
    row.append(hint, buttons)

    this.recent = element("div", "recent")
    this.recentList = element("div", null)
    this.recent.append(element("h4", null, "Your notes on this page"), this.recentList)

    this.box.append(top, this.where, this.textarea, row, this.status, this.recent)

    this.notice = element("div", "notice")
    this.noticeText = element("div", "notice-text")
    const noticeDismiss = element("button", "dismiss", "✕")
    noticeDismiss.setAttribute("aria-label", "Dismiss")
    this.notice.append(this.noticeText, noticeDismiss)

    this.root.append(style, this.marks, this.highlight, this.box, this.notice)
    document.documentElement.append(this.host)

    dismiss.addEventListener("click", () => this.close())
    cancel.addEventListener("click", () => this.close())
    send.addEventListener("click", () => this.submit())
    noticeDismiss.addEventListener("click", () => this.hideNotice())

    this.textarea.addEventListener("keydown", event => {
      if (event.key === "Escape") this.close()
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) this.submit()

      event.stopPropagation()
    })

    this.listen(document, "keydown", event => {
      const key = (event as KeyboardEvent).key

      if (key === "Alt") this.arm(true)
      if (key === "Escape" && !this.isOpen && this.selected.length) this.clearSelection()
    })
    this.listen(document, "keyup", event => {
      if ((event as KeyboardEvent).key === "Alt") this.arm(false)
    })
    this.listen(window, "blur", () => this.arm(false))
    this.listen(document, "mousemove", event => this.hover(event as MouseEvent), { passive: true })

    // Alt + click selects. Caught before the page sees it: in Chromium, Alt +
    // click on a link downloads it, and the page's own handlers should not run.
    const swallow = (event: Event) => {
      const mouse = event as MouseEvent

      if (!mouse.altKey || mouse.button !== 0 || this.contains(mouse.target as Node)) return

      mouse.preventDefault()
      mouse.stopImmediatePropagation()
    }

    this.listen(document, "mousedown", swallow, true)
    this.listen(document, "mouseup", swallow, true)
    this.listen(
      document,
      "click",
      event => {
        const mouse = event as MouseEvent

        if (!mouse.altKey || mouse.button !== 0 || this.contains(mouse.target as Node)) return

        mouse.preventDefault()
        mouse.stopImmediatePropagation()

        this.toggle(mouse.target as Element)
      },
      true,
    )

    // Alt + right-click opens the note box. A plain right-click is left alone,
    // so the page's own context menus keep working.
    this.listen(
      document,
      "contextmenu",
      event => {
        const mouse = event as MouseEvent

        if (!mouse.altKey || this.contains(mouse.target as Node)) return

        mouse.preventDefault()
        mouse.stopPropagation()

        this.open(mouse.target as Element, mouse.clientX, mouse.clientY)
      },
      true,
    )

    // Outlines are fixed boxes over the page, so they follow it when it moves.
    this.listen(window, "scroll", () => this.queueReposition(), { capture: true, passive: true })
    this.listen(window, "resize", () => this.queueReposition(), { passive: true })

    // Turbo and similar swap <body> but keep <html>, so the host survives a
    // visit; start fresh when the page changes under it.
    this.listen(document, "turbo:before-visit", () => {
      this.close()
      this.clearSelection()
    })
  }

  destroy(): void {
    for (const [target, type, listener, options] of this.listeners) {
      target.removeEventListener(type, listener, options)
    }

    this.listeners = []
    this.host.remove()
  }

  get selection(): Element[] {
    return [...this.selected]
  }

  // The notes the dev server already has for this project, sent when it connects.
  load(notes: NoteSummary[]): void {
    for (const note of notes) this.known.set(note.id, note)

    this.renderRecent()
  }

  // A note changed on the server: usually closed with a reply.
  update(note: NoteSummary): void {
    const before = this.known.get(note.id)

    this.known.set(note.id, note)
    this.renderRecent()

    if (note.status === "done" && before && before.status !== "done") {
      this.announce(note)
    }
  }

  private listen(target: EventTarget, type: string, listener: EventListener, options?: boolean | AddEventListenerOptions): void {
    target.addEventListener(type, listener, options)
    this.listeners.push([target, type, listener, options])
  }

  private contains(node: Node | null): boolean {
    return node === this.host || (node !== null && this.host.contains(node))
  }

  private arm(on: boolean): void {
    this.isArmed = on

    if (!on) this.highlight.style.display = "none"
  }

  private hover(event: MouseEvent): void {
    if (!this.isArmed || this.isOpen) return

    const node = document.elementFromPoint(event.clientX, event.clientY)

    if (!node || this.contains(node)) return

    this.outline(node)
  }

  private outline(node: Element): void {
    place(this.highlight, node)

    const file = describeSource(sourceFor(node))
    const name = node.tagName.toLowerCase()

    this.tag.textContent = file ? `${name} · ${file.split("/").pop()}` : name
  }

  private toggle(node: Element): void {
    const index = this.selected.indexOf(node)

    if (index >= 0) {
      this.selected.splice(index, 1)
    } else {
      // Selecting an element and one inside it is almost always a slip; keep the newer.
      this.selected = this.selected.filter(other => !other.contains(node) && !node.contains(other))
      this.selected.push(node)
    }

    this.renderMarks()
  }

  private clearSelection(): void {
    this.selected = []
    this.renderMarks()
  }

  private renderMarks(): void {
    this.selected = this.selected.filter(node => node.isConnected)

    this.marks.replaceChildren(
      ...this.selected.map((node, index) => {
        const mark = element("div", "mark")
        mark.append(element("div", "number", String(index + 1)))
        place(mark, node)

        return mark
      }),
    )
  }

  private queueReposition(): void {
    if (this.repositionQueued) return

    this.repositionQueued = true

    requestAnimationFrame(() => {
      this.repositionQueued = false
      this.renderMarks()
    })
  }

  private open(node: Element, x: number, y: number): void {
    // The right-clicked element joins the selection, so you can pick the last
    // one and open the box in one go.
    if (!this.selected.includes(node)) this.toggle(node)

    this.isOpen = true
    this.highlight.style.display = "none"

    const count = this.selected.length
    this.heading.textContent = count === 1 ? "Note on this element" : `Note on ${count} elements`

    this.where.replaceChildren(
      ...this.selected.map((selected, index) => {
        const source = sourceFor(selected)
        const location = describeSource(source) ?? cssPath(selected)
        const line = element("div", null, count === 1 ? location : `${index + 1}. ${location}`)

        if (count === 1) {
          const trail = source.templates.slice(source.erb?.file ? 0 : 1, 3).map(template => element("div", "muted", `in ${template.file}`))

          return fragment(line, ...trail)
        }

        return line
      }),
    )

    this.status.textContent = ""
    this.status.className = "status"
    this.textarea.value = ""
    this.renderRecent()

    const left = Math.min(x + 12, window.innerWidth - 380)
    const top = Math.min(y + 12, window.innerHeight - 280)

    Object.assign(this.box.style, { display: "block", left: `${Math.max(8, left)}px`, top: `${Math.max(8, top)}px` })

    this.textarea.focus()
  }

  // Closing keeps the selection, so a note can be reopened; Esc again clears it.
  private close(): void {
    this.isOpen = false
    this.box.style.display = "none"
    this.highlight.style.display = "none"
  }

  private async submit(): Promise<void> {
    const text = this.textarea.value.trim()

    if (!text || !this.selected.length) return

    try {
      const saved = await this.transport.send(buildNote(this.selected, text))

      this.known.set(saved.id, saved)
      this.status.className = "status"
      this.status.textContent = `Sent as note ${saved.id}.`
      this.renderRecent()

      setTimeout(() => {
        this.close()
        this.clearSelection()
      }, 900)
    } catch (error) {
      this.status.className = "status error"
      this.status.textContent = `Not sent: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  private renderRecent(): void {
    const here = [...this.known.values()]
      .filter(note => note.path === location.pathname)
      .slice(-RECENT)
      .reverse()

    this.recent.style.display = here.length ? "block" : "none"

    this.recentList.replaceChildren(
      ...here.map(note => {
        const item = element("div", "item")
        const badge = element("span", note.status === "done" ? "badge done" : "badge", note.status === "done" ? "Done" : "Sent")

        item.append(badge, document.createTextNode(note.note))

        if (note.reply) item.append(element("div", "reply", note.reply))

        return item
      }),
    )
  }

  private announce(note: NoteSummary): void {
    this.noticeText.replaceChildren(element("strong", null, "Note done. "), document.createTextNode(note.reply || note.note))
    this.notice.style.display = "flex"

    if (this.noticeTimer) clearTimeout(this.noticeTimer)

    this.noticeTimer = setTimeout(() => this.hideNotice(), 12000)
  }

  private hideNotice(): void {
    this.notice.style.display = "none"

    if (this.noticeTimer) clearTimeout(this.noticeTimer)

    this.noticeTimer = null
  }
}

function place(box: HTMLElement, node: Element): void {
  const rect = node.getBoundingClientRect()

  Object.assign(box.style, {
    display: "block",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  })
}

function fragment(...nodes: Node[]): DocumentFragment {
  const result = document.createDocumentFragment()

  result.append(...nodes)

  return result
}

function element(tag: string, className: string | null, text?: string): HTMLElement {
  const node = document.createElement(tag)

  if (className) node.className = className
  if (text) node.textContent = text

  return node
}
