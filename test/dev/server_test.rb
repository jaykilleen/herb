# frozen_string_literal: true

require "json"
require "stringio"
require "tmpdir"

require_relative "../test_helper"
require_relative "../../lib/herb/dev/server"

module Dev
  class ServerTest < Minitest::Spec
    class FakeSocket
      attr_reader :written #: Array[String]

      def initialize
        @written = []
      end

      def write(data)
        @written << data
      end

      def flush; end

      def close; end
    end

    def build_server
      Herb::Dev::Server.new(port: 0, project_path: "/tmp/project")
    end

    def build_client(role: :browser)
      Herb::Dev::Server::Client.new(socket: FakeSocket.new, version: 13, mutex: Mutex.new, role: role)
    end

    def register(server, client)
      server.instance_variable_get(:@clients) << client
    end

    test "the welcome payload reports what the server was told is broken" do
      server = build_server
      server.on_welcome { [{ file: "a.html.erb" }] }

      assert_equal [{ file: "a.html.erb" }], server.send(:broken_entries)
    end

    test "a server nobody told about broken templates welcomes with an empty list" do
      assert_equal [], build_server.send(:broken_entries)
    end

    test "a welcome hook that raises still lets the client connect" do
      server = build_server
      server.on_welcome { raise "boom" }

      assert_equal [], server.send(:broken_entries)
    end

    test "a hello frame sets the client's role" do
      server = build_server
      client = build_client

      server.handle_text_frame(client, JSON.generate({ type: "hello", role: "app" }))

      assert_equal :app, client.role
    end

    test "a hello with an unknown role leaves the default" do
      server = build_server
      client = build_client

      server.handle_text_frame(client, JSON.generate({ type: "hello", role: "admin" }))

      assert_equal :browser, client.role
    end

    test "malformed frames change nothing and raise nothing" do
      server = build_server
      client = build_client

      server.handle_text_frame(client, "{not json")
      server.handle_text_frame(client, JSON.generate(["hello"]))
      server.handle_text_frame(client, JSON.generate({ type: "schema" }))

      assert_equal :browser, client.role
    end

    test "registering and unregistering a client notifies with the open count" do
      server = build_server
      events = []

      server.on_client { |event, count| events << [event, count] }

      first = Herb::Dev::Server::Client.new(socket: FakeSocket.new, version: 13, mutex: Mutex.new, role: :browser)
      second = Herb::Dev::Server::Client.new(socket: FakeSocket.new, version: 13, mutex: Mutex.new, role: :browser)

      server.register(first)
      server.register(second)
      server.unregister(first.socket)

      assert_equal [[:connected, 1], [:connected, 2], [:disconnected, 1]], events
    end

    test "unregistering an unknown socket notifies nothing" do
      server = build_server
      events = []

      server.on_client { |event, count| events << [event, count] }

      server.unregister(FakeSocket.new)

      assert_empty events
    end

    test "a broadcast reaches every client by default" do
      server = build_server
      browser = build_client
      app = build_client(role: :app)

      register(server, browser)
      register(server, app)

      server.broadcast({ type: "invalidate" })

      refute_empty browser.socket.written
      refute_empty app.socket.written
    end

    test "a broadcast to browsers skips the app" do
      server = build_server
      browser = build_client
      app = build_client(role: :app)

      register(server, browser)
      register(server, app)

      server.broadcast({ type: "schema" }, to: :browsers)

      refute_empty browser.socket.written
      assert_empty app.socket.written
    end
    
    # Frames the server wrote to a fake socket, decoded back to messages.
    def messages(client)
      parser = WebSocket::Frame::Incoming::Client.new(version: 13)
      client.socket.written.each { |data| parser << data }
      decoded = []
      while (frame = parser.next)
        decoded << JSON.parse(frame.data)
      end
      decoded
    end
    
    def note_frame(text, ref: 1)
      JSON.generate({ type: "note", ref: ref, note: { note: text, page: { path: "/" }, source: { erb: { file: "app/views/a.html.erb", line: 3 } } } })
    end
    
    test "a note frame is saved to the project and acknowledged to the sender" do
      Dir.mktmpdir do |root|
        server = Herb::Dev::Server.new(port: 0, project_path: root)
        client = build_client
        received = []
        server.on_note { |note| received << note }
    
        server.handle_text_frame(client, note_frame("Smaller badge", ref: 7))
    
        saved = messages(client).last
        assert_equal "note_saved", saved["type"]
        assert_equal 7, saved["ref"]
        assert_equal "app/views/a.html.erb", saved["note"]["file"]
        assert_equal 3, saved["note"]["line"]
        assert_equal ["Smaller badge"], server.notes.all.map { |n| n["note"] }
        assert_equal ["Smaller badge"], received.map { |n| n["note"] }
      end
    end
    
    test "an empty note is refused with a reason" do
      Dir.mktmpdir do |root|
        server = Herb::Dev::Server.new(port: 0, project_path: root)
        client = build_client
    
        server.handle_text_frame(client, note_frame(" ", ref: 2))
    
        failed = messages(client).last
        assert_equal "note_failed", failed["type"]
        assert_equal 2, failed["ref"]
        assert_empty server.notes.all
      end
    end
    
    test "a server with no project refuses notes" do
      server = Herb::Dev::Server.new(port: 0)
      client = build_client
    
      server.handle_text_frame(client, note_frame("Hello"))
    
      assert_equal "note_failed", messages(client).last["type"]
    end
    
    test "a browser saying hello gets its project's recent notes" do
      Dir.mktmpdir do |root|
        server = Herb::Dev::Server.new(port: 0, project_path: root)
        server.notes.add({ "note" => "Earlier" })
        client = build_client
    
        server.handle_text_frame(client, JSON.generate({ type: "hello", role: "browser" }))
    
        listed = messages(client).last
        assert_equal "notes", listed["type"]
        assert_equal ["Earlier"], listed["notes"].map { |n| n["note"] }
        refute listed["notes"].first.key?("html"), "the browser gets a summary, not the page HTML"
      end
    end
    
    test "the summary sent to browsers leaves out the element HTML" do
      summary = Herb::Dev::Protocol.note_summary({ "id" => "a", "note" => "x", "element" => { "html" => "<p>" } })
    
      refute summary.key?(:element)
      assert_equal "a", summary[:id]
    end
  end
end
