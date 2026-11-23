# frozen_string_literal: true
# typed: true

require "fileutils"
require "json"
require "securerandom"
require "time"

module Herb
  module Dev
    # Notes a developer leaves on an element in the browser, for whoever works
    # on the templates next, usually an AI coding agent.
    #
    # The browser sends a note over the dev server socket, the dev server adds it
    # here, and `herb notes` lists, watches and closes them. Everything lives in
    # one JSON Lines file, `.herb/notes/notes.jsonl` in the project, so any tool can
    # read it without Herb.
    #
    # A note is open until it is closed with a short reply, which the dev server
    # sends back to the browser.
    #
    class Notes
      DIRECTORY = ".herb/notes" #: String
      FILE = "notes.jsonl" #: String
      SCHEMA = "herb-note/1" #: String
      STATUSES = ["open", "done"].freeze #: Array[String]
      MAX_NOTE = 4000 #: Integer
      MAX_REPLY = 2000 #: Integer

      class Error < StandardError; end

      attr_reader :path #: String

      #: (String) -> void
      def initialize(root)
        @path = File.join(root, DIRECTORY, FILE)
      end

      #: () -> Array[Hash[String, untyped]]
      def all
        return [] unless File.exist?(@path)

        File.open(@path) { |file| parse_lines(file) }
      end

      #: () -> Array[Hash[String, untyped]]
      def open
        all.select { |note| note["status"] == "open" }
      end

      #: (String) -> Hash[String, untyped]?
      def find(id)
        all.find { |note| note["id"] == id }
      end

      # Stores a note sent from the browser and returns it with its id.
      #: (Hash[String, untyped]) -> Hash[String, untyped]
      def add(payload)
        text = payload["note"].to_s.strip

        raise Error, "A note needs some text." if text.empty?
        raise Error, "A note can be at most #{MAX_NOTE} characters." if text.length > MAX_NOTE

        note = payload.merge(
          "schema" => SCHEMA,
          "id" => SecureRandom.hex(4),
          "note" => text,
          "status" => "open",
          "reply" => nil,
          "received_at" => Time.now.utc.iso8601,
          "done_at" => nil
        )

        locked { |file| file.write("#{JSON.generate(note)}\n") }

        note
      end

      # Closes a note with a short reply for the person who left it.
      #: (String, ?reply: String?) -> Hash[String, untyped]
      def resolve(id, reply: nil)
        reply = reply.to_s.strip
        raise Error, "A reply can be at most #{MAX_REPLY} characters." if reply.length > MAX_REPLY

        update(id) do |note|
          note.merge("status" => "done", "reply" => reply.empty? ? nil : reply, "done_at" => Time.now.utc.iso8601)
        end
      end

      # Calls the block with each note that is added from now on.
      # Polls, so it needs nothing beyond Ruby; a note shows within `interval` seconds.
      #: (?interval: Float, ?include_open: bool) { (Hash[String, untyped]) -> void } -> void
      def watch(interval: 0.5, include_open: false)
        seen = {} #: Hash[String, bool]

        all.each do |note|
          if include_open && note["status"] == "open"
            yield note
          end

          seen[note["id"]] = true
        end

        stamp = signature

        loop do
          sleep interval

          current = signature
          next if current == stamp

          stamp = current

          all.each do |note|
            next if seen[note["id"]]

            seen[note["id"]] = true
            yield note
          end
        end
      end

      # Changes since the last call, keyed by id: used by the dev server to tell
      # the browser when a note has been closed.
      #: () -> Array[Hash[String, untyped]]
      def changed_since_last_check
        @known ||= all.to_h { |note| [note["id"], note["status"]] }

        current = all
        changed = current.reject { |note| @known[note["id"]] == note["status"] }
        @known = current.to_h { |note| [note["id"], note["status"]] }

        changed
      end

      #: () -> [Integer, Float]?
      def signature
        return nil unless File.exist?(@path)

        stat = File.stat(@path)

        [stat.size, stat.mtime.to_f]
      end

      private

      # One note per line. A line that does not parse is skipped, not fatal.
      #: (IO) -> Array[Hash[String, untyped]]
      def parse_lines(io)
        io.each_line.filter_map do |line|
          next if line.strip.empty?

          JSON.parse(line)
        rescue JSON::ParserError
          nil
        end
      end

      #: (String) { (Hash[String, untyped]) -> Hash[String, untyped] } -> Hash[String, untyped]
      def update(id)
        updated = nil #: Hash[String, untyped]?

        locked do |file|
          file.rewind
          notes = parse_lines(file)

          index = notes.index { |note| note["id"] == id }
          raise Error, "No note with id #{id}." unless index

          updated = yield(notes[index])
          notes[index] = updated

          file.rewind
          file.truncate(0)
          notes.each { |note| file.write("#{JSON.generate(note)}\n") }
        end

        updated or raise Error, "No note with id #{id}."
      end

      #: () { (File) -> void } -> void
      def locked
        FileUtils.mkdir_p(File.dirname(@path))
        ignore_directory

        File.open(@path, File::RDWR | File::CREAT | File::APPEND) do |file|
          file.flock(File::LOCK_EX)
          yield file
        ensure
          file.flock(File::LOCK_UN)
        end
      end

      # Keeps notes out of version control without touching the project's own .gitignore.
      #: () -> void
      def ignore_directory
        ignore = File.join(File.dirname(@path), ".gitignore")
        File.write(ignore, "*\n") unless File.exist?(ignore)
      end
    end
  end
end
