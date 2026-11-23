# frozen_string_literal: true

require "json"
require "tmpdir"

require_relative "../test_helper"
require_relative "../../lib/herb/dev/notes"

module Dev
  class NotesTest < Minitest::Spec
    def with_notes
      Dir.mktmpdir do |root|
        yield Herb::Dev::Notes.new(root), root
      end
    end

    def payload(text = "Make this badge smaller")
      {
        "schema" => "agent-note/1",
        "note" => text,
        "page" => { "path" => "/campaigns/1" },
        "source" => { "via" => "herb", "erb" => { "file" => "app/views/a.html.erb", "line" => 7 }, "templates" => [] },
      }
    end

    test "a note is stored with an id, open, in .herb/notes/notes.jsonl" do
      with_notes do |notes, root|
        note = notes.add(payload)

        assert_match(/\A\h{8}\z/, note["id"])
        assert_equal "open", note["status"]
        assert_equal "herb-note/1", note["schema"]
        assert_equal File.join(root, ".herb", "notes", "notes.jsonl"), notes.path
        assert_equal [note["id"]], notes.all.map { |n| n["id"] }
      end
    end

    test "the notes directory ignores itself, leaving the rest of .herb alone" do
      with_notes do |notes, root|
        notes.add(payload)

        assert_equal "*\n", File.read(File.join(root, ".herb", "notes", ".gitignore"))
        refute File.exist?(File.join(root, ".herb", ".gitignore"))
      end
    end

    test "a note without text is refused" do
      with_notes do |notes|
        assert_raises(Herb::Dev::Notes::Error) { notes.add(payload("   ")) }
        assert_empty notes.all
      end
    end

    test "closing a note keeps the others and records the reply" do
      with_notes do |notes|
        first = notes.add(payload("one"))
        second = notes.add(payload("two"))

        closed = notes.resolve(first["id"], reply: "Made it smaller.")

        assert_equal "done", closed["status"]
        assert_equal "Made it smaller.", closed["reply"]
        refute_nil closed["done_at"]
        assert_equal [second["id"]], notes.open.map { |n| n["id"] }
        assert_equal 2, notes.all.size
      end
    end

    test "closing an unknown note raises" do
      with_notes do |notes|
        assert_raises(Herb::Dev::Notes::Error) { notes.resolve("nope") }
      end
    end

    test "changed_since_last_check reports new and closed notes once" do
      with_notes do |notes|
        notes.changed_since_last_check
        note = notes.add(payload)

        assert_equal [note["id"]], notes.changed_since_last_check.map { |n| n["id"] }
        assert_empty notes.changed_since_last_check

        notes.resolve(note["id"], reply: "Done")

        assert_equal ["done"], notes.changed_since_last_check.map { |n| n["status"] }
      end
    end

    test "watch yields notes added after it starts, and open ones first when asked" do
      with_notes do |notes|
        existing = notes.add(payload("before"))
        seen = []

        thread = Thread.new do
          notes.watch(interval: 0.05, include_open: true) { |note| seen << note["note"] }
        end

        sleep 0.15
        notes.add(payload("after"))
        sleep 0.3
        thread.kill

        assert_equal ["before", "after"], seen
        assert_equal "open", existing["status"]
      end
    end
  end
end
