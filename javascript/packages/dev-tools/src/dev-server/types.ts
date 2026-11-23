import type { RuntimeDiagnostic } from "../runtime/report"
import type { TemplateManifest } from "@herb-tools/client"
import type { NoteSummary } from "../notes/notes"

export interface HelloMessage {
  type: "hello"
  role: "browser"
  capabilities?: {
    runtime: boolean
    regions: number
  }
}

export interface SchemaVersion {
  from: string | null
  to: string | null
}

export interface SchemaMessage {
  type: "schema"
  file: string
  mode: "client" | "server" | null
  version: SchemaVersion
  manifest: TemplateManifest | null
  static_markup: string | null
  changed_statics?: string[] | null
  statics: Record<string, string> | null
  remap: { slots: Record<string, number | null> } | null
  diagnostics: RuntimeDiagnostic[]
  source: string | null
}

export interface InvalidateMessage {
  type: "invalidate"
  file: string
  version: string | null
  node_path: number[]
  scope: "state" | "static" | "fetch"
}

export interface ParseError {
  name: string
  message: string
  line: number
  column: number
  code?: string
  origin?: string
  suggestion?: string | null
}

export interface ErrorMessage {
  type: "error"
  file: string
  errors: ParseError[]
  source?: string
}

export interface BrokenFile {
  file: string
  source?: string
  errors?: ParseError[]
  diagnostics?: RuntimeDiagnostic[]
}

export interface WelcomeMessage {
  type: "welcome"
  project: string
  compiler?: boolean
  broken_files?: BrokenFile[]
}

export const DEV_SERVER_COMMAND = "bundle exec herb dev"

export interface AssetMessage {
  type: "asset"
  kind: "stylesheet" | "script"
  file: string
}

export interface NotesMessage {
  type: "notes"
  notes: NoteSummary[]
}

export interface NoteSavedMessage {
  type: "note_saved"
  ref: number
  note: NoteSummary
}

export interface NoteFailedMessage {
  type: "note_failed"
  ref: number
  message: string
}

export interface NoteUpdatedMessage {
  type: "note_updated"
  note: NoteSummary
}

export type NoteMessage = NotesMessage | NoteSavedMessage | NoteFailedMessage | NoteUpdatedMessage

export type HerbMessage = WelcomeMessage | SchemaMessage | InvalidateMessage | ErrorMessage | AssetMessage | NoteMessage
export type ConnectionState = "connected" | "disconnected" | "given-up"
export type MessageHandler = (message: HerbMessage) => void

export interface ConnectionOptions {
  url: string
  reconnectInterval?: number
  maxReconnectAttempts?: number
  onMessage?: MessageHandler
  onConnect?: () => void
  onDisconnect?: () => void
  onGivenUp?: () => void
  onReconnecting?: (attempt: number, maxAttempts: number, delay: number) => void
}

export interface DiagnosticSink {
  report(file: string, diagnostics: RuntimeDiagnostic[]): void
  clear(file: string): void
  clearAll(): void
}

export interface HotReloadHandler {
  onSchema(message: SchemaMessage): void
  onInvalidate(message: InvalidateMessage): void
  onError(message: ErrorMessage): void
  onAsset(message: AssetMessage): void
}

export interface HerbClientOptions {
  port?: number
  host?: string
  diagnostics?: () => DiagnosticSink | null
  hotReload?: HotReloadHandler
  onSchema?: (message: SchemaMessage) => void
  onInvalidate?: (message: InvalidateMessage) => void
  onError?: (message: ErrorMessage) => void
  onAsset?: (message: AssetMessage) => void
  onNotes?: (notes: NoteSummary[]) => void
  onNoteUpdated?: (note: NoteSummary) => void
  onConnect?: () => void
  onDisconnect?: () => void
}
