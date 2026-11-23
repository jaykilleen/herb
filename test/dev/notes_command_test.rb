# frozen_string_literal: true

require "json"
require "stringio"
require "tmpdir"

require_relative "../test_helper"
require_relative "../../lib/herb/dev/notes_command"

module Dev
  class NotesCommandTest < Minitest::Spec
    def run_command(root, *args)
      out = StringIO.new
      code = Herb::Dev::NotesCommand.new([*args, "--path", root], out: out).run

      [code, out.string]
    end

    def add(root, text)
      Herb::Dev::Notes.new(root).add(
        "note" => text,
        "page" => { "path" => "/campaigns/1" },
        "source" => { "erb" => { "file" => "app/views/a.html.erb", "line" => 7 }, "templates" => [] }
      )
    end

    test "list prints one line per open note, leading with the id and file" do
      Dir.mktmpdir do |root|
        note = add(root, "Make it\nsmaller")

        code, out = run_command(root)

        assert_equal 0, code
        assert_equal "Herb note #{note["id"]} (app/views/a.html.erb:7): Make it smaller\n", out
      end
    end

    test "list says so when there are none" do
      Dir.mktmpdir do |root|
        assert_equal [0, "No notes.\n"], run_command(root, "list")
      end
    end

    test "done closes a note with a reply, and list no longer shows it" do
      Dir.mktmpdir do |root|
        note = add(root, "Smaller")

        code, out = run_command(root, "done", note["id"], "--reply", "Dropped it to text-xs.")

        assert_equal 0, code
        assert_equal "Closed note #{note["id"]}.\n", out
        assert_equal "Dropped it to text-xs.", Herb::Dev::Notes.new(root).find(note["id"])["reply"]
        assert_equal [0, "No notes.\n"], run_command(root)
      end
    end

    test "show prints the whole note as JSON" do
      Dir.mktmpdir do |root|
        note = add(root, "Smaller")

        code, out = run_command(root, "show", note["id"])

        assert_equal 0, code
        assert_equal "Smaller", JSON.parse(out)["note"]
      end
    end

    test "an unknown note id fails" do
      Dir.mktmpdir do |root|
        code, = run_command(root, "done", "nope")

        assert_equal 1, code
      end
    end
  end
end
