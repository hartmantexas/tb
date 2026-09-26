/**
 * Best-effort UI automation for the one step Chrome refuses to expose an API for:
 * turning on Developer mode and clicking "Load unpacked".
 *
 * Why this is UI scripting and not something cleaner — every alternative is a dead end:
 *   - `--load-extension` is parsed at launch only, so it would mean quitting the user's
 *     Chrome, which is the exact thing the bridge exists to avoid.
 *   - External Extensions JSON (`external_crx`) is Web-Store-only on macOS.
 *   - `extensions.ui.developer_mode` lives in the profile's Preferences file, but Chrome
 *     holds prefs in memory and rewrites that file on exit, so a live edit is discarded.
 *   - chrome://extensions is built from shadow DOM on a privileged page, so neither
 *     Chrome's `execute javascript` AppleScript verb nor CDP can touch its controls.
 * That leaves the macOS accessibility tree.
 *
 * This is deliberately BEST EFFORT and opt-in (`--auto`). It never reports success on
 * its own: the bridge handshake is the oracle. If any step here misses, the caller
 * falls back to the printed manual instructions and the user finishes by hand — which
 * is exactly the behaviour they would have had anyway. So a failure costs nothing.
 *
 * It also only ever matters once per profile: Developer mode is a persistent pref, and
 * an unpacked extension stays loaded across restarts.
 */

export interface AutoInstallResult {
  ok: boolean;
  /** Why it bailed — shown to the user so a failure is never mysterious. */
  reason?: "accessibility-denied" | "no-window" | "no-toggle" | "no-button" | "script-error";
  detail?: string;
}

/**
 * Depth-capped search of the accessibility tree. Chrome renders its own UI as web
 * content, so the controls are nested well below the window, but an uncapped
 * `entire contents` on a Chrome window can hang for tens of seconds.
 */
const APPLESCRIPT = String.raw`
on run argv
  set extPath to item 1 of argv
  set appName to item 2 of argv

  tell application appName to activate
  delay 0.7

  tell application "System Events"
    if not (exists process appName) then return "no-window"
    tell process appName
      set frontmost to true
      if (count of windows) = 0 then return "no-window"
      set win to window 1

      -- 1. Developer mode. Already on is the common case after first run.
      set devToggle to my findControl(win, "Developer mode", 0)
      if devToggle is missing value then return "no-toggle"
      set wasOn to false
      try
        if (value of devToggle as integer) is 1 then set wasOn to true
      end try
      if not wasOn then
        click devToggle
        delay 1.0
      end if

      -- 2. Load unpacked. Only exists once Developer mode is on, hence the order.
      set loadBtn to my findControl(win, "Load unpacked", 0)
      if loadBtn is missing value then return "no-button"
      click loadBtn
      delay 1.4

      -- 3. The open panel. "Go to folder" is the stable way in — typing a path into
      -- the sheet directly depends on the current directory, this does not.
      keystroke "g" using {command down, shift down}
      delay 0.7
      keystroke extPath
      delay 0.5
      keystroke return
      delay 1.0
      keystroke return
    end tell
  end tell
  return "ok"
end run

on findControl(root, targetName, depth)
  if depth > 12 then return missing value
  tell application "System Events"
    set kids to {}
    try
      set kids to UI elements of root
    on error
      return missing value
    end try
    repeat with k in kids
      set label to ""
      try
        if name of k is not missing value then set label to name of k
      end try
      if label is "" then
        try
          if description of k is not missing value then set label to description of k
        end try
      end if
      if label contains targetName then return contents of k
      set deeper to my findControl(k, targetName, depth + 1)
      if deeper is not missing value then return deeper
    end repeat
  end tell
  return missing value
end findControl
`;

/**
 * Drive chrome://extensions through the accessibility tree.
 * Assumes the caller has already opened that page in `appName`.
 */
export async function autoLoadUnpacked(extDir: string, appName: string): Promise<AutoInstallResult> {
  if (process.platform !== "darwin") {
    return { ok: false, reason: "script-error", detail: "UI automation is macOS-only" };
  }
  const { execFileSync } = await import("child_process");
  try {
    const out = execFileSync("osascript", ["-", extDir, appName], {
      input: APPLESCRIPT,
      encoding: "utf-8",
      timeout: 90000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (out === "ok") return { ok: true };
    if (out === "no-window") return { ok: false, reason: "no-window" };
    if (out === "no-toggle") return { ok: false, reason: "no-toggle" };
    if (out === "no-button") return { ok: false, reason: "no-button" };
    return { ok: false, reason: "script-error", detail: out };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // -1719 / -25211 are the accessibility-permission errors; macOS also surfaces the
    // refusal as plain text depending on version.
    if (/-1719|-25211|not allowed assistive|accessibility/i.test(msg)) {
      return { ok: false, reason: "accessibility-denied", detail: msg };
    }
    return { ok: false, reason: "script-error", detail: msg.split("\n")[0] };
  }
}

/** Human-readable recovery advice for each failure mode. */
export function autoInstallHint(r: AutoInstallResult, appName: string): string {
  switch (r.reason) {
    case "accessibility-denied":
      return (
        `Your terminal needs Accessibility permission to click for you.\n` +
        `  System Settings › Privacy & Security › Accessibility → enable your terminal app,\n` +
        `  then re-run. (One time. Finish the three steps by hand below in the meantime.)`
      );
    case "no-window":
      return `Couldn't find a ${appName} window to drive. Make sure ${appName} is open, then re-run.`;
    case "no-toggle":
      return (
        `Couldn't find the "Developer mode" toggle in the accessibility tree.\n` +
        `  Chrome may have changed that page. Flip it by hand (top right) — it's a one-time switch.`
      );
    case "no-button":
      return (
        `Developer mode is on, but "Load unpacked" didn't appear in time.\n` +
        `  Click it by hand — the path is already on your clipboard.`
      );
    default:
      return `UI automation bailed (${r.detail ?? "unknown"}). The manual steps below still work.`;
  }
}
