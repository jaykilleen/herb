# frozen_string_literal: true
# typed: true

require "json"
require "optparse"

require_relative "notes"
require_relative "protocol"
require_relative "../configuration"

module Herb
  module Dev
    # `herb notes`: read and close the notes left on elements in the browser.
    #
    #   herb notes                  open notes, one line each
    #   herb notes all              every note, newest last
    #   herb notes show ID          one note in full, as JSON
    #   herb notes watch            one line per new note, until stopped
    #   herb notes done ID          close a note (--reply "what changed")
    #
    # `watch` prints one line per note and nothing else, so an AI coding agent can
    # run it in the background and wake on each line.
    #
    class NotesCommand
      USAGE = <<~USAGE
        Usage:
          bundle exec herb notes [list]                 Open notes, one line each.
          bundle exec herb notes all                    Every note, newest last.
          bundle exec herb notes show ID                One note in full, as JSON.
          bundle exec herb notes watch                  Print one line per new note until stopped.
          bundle exec herb notes done ID [--reply TEXT] Close a note, with a reply shown in the browser.

        Options:
          --path PATH    Project directory (default: current directory)
          --open         With watch: print notes that are already open first
          --once         With watch: exit after the first note (for agents that wake when a command ends)
          --json         With list and all: print JSON
      USAGE

      #: (Array[String], ?out: IO) -> void
      def initialize(args, out: $stdout)
        @args = args.dup
        @out = out
        @path = "."
        @reply = nil
        @include_open = false
        @once = false
        @json = false
      end

      #: () -> Integer
      def run
        parse_options

        command = @args.shift || "list"

        case command
        when "list" then list(notes.open)
        when "all" then list(notes.all)
        when "show" then show(@args.shift)
        when "watch" then watch
        when "done" then done(@args.shift)
        when "help", "-h", "--help" then usage(0)
        else usage(1, "Unknown notes command: '#{command}'")
        end
      rescue Notes::Error, OptionParser::ParseError => e
        warn e.message
        1
      end

      private

      #: () -> void
      def parse_options
        OptionParser.new do |parser|
          parser.on("--path PATH") { |value| @path = value }
          parser.on("--reply TEXT") { |value| @reply = value }
          parser.on("--open") { @include_open = true }
          parser.on("--once") { @once = true }
          parser.on("--json") { @json = true }
        end.parse!(@args)
      end

      #: () -> Notes
      def notes
        @notes ||= Notes.new(project_root)
      end

      #: () -> String
      def project_root
        config = Herb::Configuration.load(@path)

        File.realpath(File.expand_path(config.project_root || @path))
      rescue StandardError
        File.expand_path(@path)
      end

      #: (Array[Hash[String, untyped]]) -> Integer
      def list(entries)
        if @json
          @out.puts JSON.pretty_generate(entries)
        elsif entries.empty?
          @out.puts "No notes."
        else
          entries.each { |note| @out.puts line(note) }
        end

        0
      end

      #: (String?) -> Integer
      def show(id)
        return usage(1, "Which note? herb notes show ID") unless id

        note = notes.find(id) or raise Notes::Error, "No note with id #{id}."
        @out.puts JSON.pretty_generate(note)

        0
      end

      #: () -> Integer
      def watch
        @out.sync = true if @out.respond_to?(:sync=)

        catch(:first_note) do
          notes.watch(include_open: @include_open) do |note|
            next unless note["status"] == "open"

            @out.puts line(note)
            throw :first_note if @once
          end
        end

        0
      rescue Interrupt
        0
      end

      #: (String?) -> Integer
      def done(id)
        return usage(1, "Which note? herb notes done ID --reply \"what changed\"") unless id

        note = notes.resolve(id, reply: @reply)
        @out.puts "Closed note #{note["id"]}."

        0
      end

      # One line per note: what an agent sees first, so it leads with the id and
      # the file, and points at `show` for the rest.
      #: (Hash[String, untyped]) -> String
      def line(note)
        summary = Protocol.note_summary(note)
        location = [summary[:file], summary[:line]].compact.join(":")
        text = note["note"].to_s.gsub(/\s+/, " ").strip
        status = note["status"] == "open" ? "" : " [#{note["status"]}]"
        where = location.empty? ? summary[:path] : location
        more = summary[:elements] > 1 ? " and #{summary[:elements] - 1} more" : ""

        "Herb note #{note["id"]}#{status} (#{where}#{more}): #{text}"
      end

      #: (Integer, ?String?) -> Integer
      def usage(code, message = nil)
        warn message if message
        (code.zero? ? @out : $stderr).puts USAGE

        code
      end
    end
  end
end
