// "__APP_NAME__" — menu bar status app for the growth engine.
// Reads the .status.json the tick writes; no DB access, no network.
// Built by deploy/build-menubar.sh (placeholders injected there).
import AppKit
import Foundation

let appName = "__APP_NAME__"
let repoPath = "__REPO__"
let statusPath = repoPath + "/.status.json"
let logPath = repoPath + "/.runner.log"
let dashboardScript = repoPath + "/deploy/open-dashboard.sh"
let tickScript = "__TICK_SCRIPT__"
let tickIntervalSeconds: TimeInterval = 1800
// After a failed/blocked attempt, wait this long before trying again.
let tickRetrySeconds: TimeInterval = 300

struct Posture: Decodable {
  let dryRun: Bool
  let liveChannels: [String]
}

struct EngineStatus: Decodable {
  let ts: String
  let ok: Bool
  let error: String?
  let ready: Int?
  let tally: [String: Int]?
  let queue: [String: Int]?
  let posture: Posture?
}

let isoFmt: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f
}()

func timeAgo(_ d: Date) -> String {
  let s = Int(-d.timeIntervalSinceNow)
  if s < 90 { return "just now" }
  if s < 3600 { return "\(s / 60) min ago" }
  if s < 86400 { return "\(s / 3600) h ago" }
  return "\(s / 86400) d ago"
}

class AppDelegate: NSObject, NSApplicationDelegate {
  var item: NSStatusItem!
  var timer: Timer?
  // The app IS the scheduler: a launchd agent cannot run this repo (it lives
  // under ~/Documents, a TCC-protected folder background agents get denied
  // from — exit 126, no prompt). A user-launched app has normal file access
  // and its children inherit it.
  var tickProcess: Process?
  var lastTickAttempt = Date.distantPast
  var tickSpawnError: String?

  func applicationDidFinishLaunching(_ n: Notification) {
    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    if let b = item.button {
      b.image = NSImage(systemSymbolName: "__SYMBOL__", accessibilityDescription: appName)
      b.imagePosition = .imageLeading
    }
    refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
      self.maybeScheduleTick()
      self.refresh()
    }
    timer?.tolerance = 5
  }

  /// Runs a tick when the last recorded one is older than the interval.
  /// Also the sleep/wake catch-up: staleness triggers one run after wake.
  func maybeScheduleTick() {
    guard tickProcess == nil else { return }
    guard -lastTickAttempt.timeIntervalSinceNow >= tickRetrySeconds else { return }
    let lastTick = readStatus().flatMap { isoFmt.date(from: $0.ts) } ?? .distantPast
    if -lastTick.timeIntervalSinceNow >= tickIntervalSeconds { spawnTick() }
  }

  func spawnTick() {
    guard tickProcess == nil else { return }
    lastTickAttempt = Date()
    tickSpawnError = nil
    if !FileManager.default.fileExists(atPath: logPath) {
      FileManager.default.createFile(atPath: logPath, contents: nil)
    }
    let log = FileHandle(forWritingAtPath: logPath)
    log?.seekToEndOfFile()
    let p = Process()
    p.executableURL = URL(fileURLWithPath: tickScript)
    p.currentDirectoryURL = URL(fileURLWithPath: repoPath)
    if let log = log {
      p.standardOutput = log
      p.standardError = log
    }
    p.terminationHandler = { [weak self] _ in
      try? log?.close()
      DispatchQueue.main.async {
        self?.tickProcess = nil
        self?.refresh()
      }
    }
    do {
      try p.run()
      tickProcess = p
    } catch {
      tickSpawnError = error.localizedDescription
      try? log?.close()
    }
    refresh()
  }

  func readStatus() -> EngineStatus? {
    guard let data = FileManager.default.contents(atPath: statusPath) else { return nil }
    return try? JSONDecoder().decode(EngineStatus.self, from: data)
  }

  func refresh() {
    let status = readStatus()
    let tickDate = status.flatMap { isoFmt.date(from: $0.ts) }
    let running = tickProcess != nil
    let stalled = !running
      && (tickDate.map { -$0.timeIntervalSinceNow > tickIntervalSeconds * 2 + 120 } ?? true)
    let failed = status.map { !$0.ok } ?? false
    let ready = status?.ready ?? 0

    if let b = item.button {
      if failed || stalled {
        b.title = " ⚠︎"
      } else if ready > 0 {
        b.title = " \(ready)"
      } else {
        b.title = ""
      }
    }

    let menu = NSMenu()
    menu.autoenablesItems = false

    func info(_ text: String) {
      let mi = NSMenuItem(title: text, action: nil, keyEquivalent: "")
      mi.isEnabled = false
      menu.addItem(mi)
    }

    if running { info("Tick running now…") }
    if let e = tickSpawnError { info("⚠︎ Could not start tick: \(e)") }
    if let s = status {
      if let d = tickDate {
        let outcome = s.ok ? summarize(s.tally) : "FAILED: \(s.error ?? "unknown")"
        info("Last tick \(timeAgo(d)): \(outcome)")
        if stalled {
          info("⚠︎ No tick in over an hour")
        }
      }
      if let q = s.queue {
        let pending = q["pending"] ?? 0
        let published = q["published"] ?? 0
        let failedRows = q["failed"] ?? 0
        var line = "Queue: \(pending) pending · \(published) published"
        if ready > 0 { line += " · \(ready) awaiting approval" }
        if failedRows > 0 { line += " · \(failedRows) failed" }
        info(line)
      }
      if let p = s.posture {
        let live = p.liveChannels.isEmpty ? "none" : p.liveChannels.joined(separator: ", ")
        info("Live channels: \(live)\(p.dryRun ? "  (others dry-run)" : "")")
      }
    } else {
      info("No status yet — waiting for the first tick")
    }

    menu.addItem(.separator())

    let approve = NSMenuItem(
      title: ready > 0 ? "Review approvals (\(ready) waiting)…" : "Open dashboard…",
      action: #selector(openDashboard), keyEquivalent: "")
    approve.target = self
    menu.addItem(approve)

    let tick = NSMenuItem(
      title: running ? "Tick in progress…" : "Run tick now",
      action: running ? nil : #selector(runTick), keyEquivalent: "")
    tick.target = self
    tick.isEnabled = !running
    menu.addItem(tick)

    let log = NSMenuItem(title: "Open runner log", action: #selector(openLog), keyEquivalent: "")
    log.target = self
    menu.addItem(log)

    menu.addItem(.separator())
    let quit = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    menu.addItem(quit)

    item.menu = menu
  }

  func summarize(_ tally: [String: Int]?) -> String {
    guard let t = tally, !t.isEmpty else { return "idle" }
    return t.sorted { $0.key < $1.key }
      .map { "\($0.value) \($0.key.replacingOccurrences(of: "_", with: " "))" }
      .joined(separator: ", ")
  }

  @objc func openDashboard() {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/bash")
    p.arguments = [dashboardScript]
    try? p.run()
  }

  @objc func runTick() {
    spawnTick()
  }

  @objc func openLog() {
    NSWorkspace.shared.open(URL(fileURLWithPath: logPath))
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
