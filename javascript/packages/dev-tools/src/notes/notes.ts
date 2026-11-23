import notesStyles from "./notes.css"

import { buildNote, cssPath, describeSource, sourceFor } from "./source.js"

import type { Note } from "./source.js"

// Notes: hold Alt to outline the element under the pointer with the template
// that drew it, Alt + right-click to leave a note on it, Ctrl+Enter to send.
// The note goes to the dev server, which keeps it in .herb/notes/notes.jsonl
// for `herb notes` (and whatever coding agent is watching). When the note is
// closed, its reply comes back here.
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
  received_at: string | null
  done_at: string | null
}

export interface NotesTransport {
  send(note: Note): Promise<NoteSummary>
}

const RECENT = 5

export class Notes {
  private host: HTMLElement
  private highlight: HTMLElement
  private tag: HTMLElement
  private box: HTMLElement
  private where: HTMLElement
  private textarea: HTMLTextAreaElement
  private status: HTMLElement
  private recent: HTMLElement
  private recentList: HTMLElement
  private notice: HTMLElement
  private noticeTimer: ReturnType<typeof setTimeout> | null = null
  private isArmed = false
  private target: Element | null = null
  private known = new Map<string, NoteSummary>()
  private listeners: Array<[EventTarget, string, EventListener, boolean | AddEventListenerOptions | undefined]> = []

  constructor(private transport: NotesTransport) {
    this.host = document.createElement("div")
    this.host.setAttribute("data-herb-notes", "")

    const root = this.host.attachShadow({ mode: "open" })
    const style = document.createElement("style")
    style.textContent = notesStyles

    this.highlight = element("div", "highlight")
    this.tag = element("div", "tag")
    this.highlight.append(this.tag)

    this.box = element("div", "box")
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

    this.box.append(this.where, this.textarea, row, this.status, this.recent)
    this.notice = element("div", "notice")

    root.append(style, this.highlight, this.box, this.notice)
    document.documentElement.append(this.host)

    cancel.addEventListener("click", () => this.close())
    send.addEventListener("click", () => this.submit())

    this.textarea.addEventListener("keydown", event => {
      if (event.key === "Escape") this.close()
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) this.submit()

      event.stopPropagation()
    })

    this.listen(document, "keydown", event => {
      if ((event as KeyboardEvent).key === "Alt") this.arm(true)
    })
    this.listen(document, "keyup", event => {
      if ((event as KeyboardEvent).key === "Alt") this.arm(false)
    })
    this.listen(window, "blur", () => this.arm(false))
    this.listen(document, "mousemove", event => this.hover(event as MouseEvent), { passive: true })

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

    // Turbo and similar swap <body> but keep <html>, so the host survives a
    // visit; close an open note when the page changes under it.
    this.listen(document, "turbo:before-visit", () => this.close())
  }

  destroy(): void {
    for (const [target, type, listener, options] of this.listeners) {
      target.removeEventListener(type, listener, options)
    }

    this.listeners = []
    this.host.remove()
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

    if (!on && !this.target) this.highlight.style.display = "none"
  }

  private hover(event: MouseEvent): void {
    if (!this.isArmed || this.target) return

    const node = document.elementFromPoint(event.clientX, event.clientY)

    if (!node || this.contains(node)) return

    this.outline(node)
  }

  private outline(node: Element): void {
    const rect = node.getBoundingClientRect()

    Object.assign(this.highlight.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    })

    const file = describeSource(sourceFor(node))
    const name = node.tagName.toLowerCase()

    this.tag.textContent = file ? `${name} · ${file.split("/").pop()}` : name
  }

  private open(node: Element, x: number, y: number): void {
    this.target = node
    this.outline(node)

    const source = sourceFor(node)
    const lines: string[] = []

    if (source.erb?.file) lines.push(describeSource(source) as string)

    source.templates.slice(0, 3).forEach(template => lines.push(template.file))

    if (!lines.length) lines.push(cssPath(node))

    this.where.replaceChildren(...lines.map((line, index) => element("div", index === 0 ? null : "muted", index === 0 ? line : `in ${line}`)))

    this.status.textContent = ""
    this.status.className = "status"
    this.textarea.value = ""
    this.renderRecent()

    const left = Math.min(x + 12, window.innerWidth - 380)
    const top = Math.min(y + 12, window.innerHeight - 260)

    Object.assign(this.box.style, { display: "block", left: `${Math.max(8, left)}px`, top: `${Math.max(8, top)}px` })

    this.textarea.focus()
  }

  private close(): void {
    this.target = null
    this.box.style.display = "none"
    this.highlight.style.display = "none"
  }

  private async submit(): Promise<void> {
    const text = this.textarea.value.trim()

    if (!text || !this.target) return

    try {
      const saved = await this.transport.send(buildNote(this.target, text))

      this.known.set(saved.id, saved)
      this.status.className = "status"
      this.status.textContent = `Sent as note ${saved.id}.`
      this.renderRecent()

      setTimeout(() => this.close(), 900)
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
    const title = element("strong", null, "Note done. ")

    this.notice.replaceChildren(title, document.createTextNode(note.reply || note.note))
    this.notice.style.display = "block"

    if (this.noticeTimer) clearTimeout(this.noticeTimer)

    this.noticeTimer = setTimeout(() => {
      this.notice.style.display = "none"
    }, 8000)
  }
}

function element(tag: string, className: string | null, text?: string): HTMLElement {
  const node = document.createElement(tag)

  if (className) node.className = className
  if (text) node.textContent = text

  return node
}
