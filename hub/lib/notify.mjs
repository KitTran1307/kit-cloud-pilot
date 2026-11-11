// A desktop notification for the person, with no module to install: Windows toast through Windows PowerShell's WinRT
// API, macOS through osascript, Linux through notify-send (libnotify). Missing tools fail silently.
// CLOUD_PILOT_NOTIFY=0 (or CLOUD_PILOT_NO_TOAST=1; the KIT_HUB_ names too) turns notifications off.
import { spawn } from 'node:child_process';
import { setting } from './config.mjs';
import { resolveSystemExe, safeCwd } from './exe.mjs';

const APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const xmlEscape = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
// AppleScript string literal: backslashes and quotes escaped, line breaks flattened.
const appleQuote = (s) => `"${String(s).replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

export function toastScript(title, text) {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(text)}</text></binding></visual></toast>`;
  const b64 = Buffer.from(xml, 'utf8').toString('base64');
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    `$x = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`,
    '$d = New-Object Windows.Data.Xml.Dom.XmlDocument; $d.LoadXml($x)',
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($d))`,
  ].join('; ');
}

/** The command that shows a notification on this platform: [file, args], or null where there is none. */
export function notifyCommand(title, text, platform = process.platform) {
  const t = clip(title, 120);
  const body = clip(text, 400);
  if (platform === 'win32') {
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', toastScript(t, body)]];
  }
  if (platform === 'darwin') return ['osascript', ['-e', `display notification ${appleQuote(body)} with title ${appleQuote(t)}`]];
  if (platform === 'linux' || platform === 'freebsd' || platform === 'openbsd') return ['notify-send', ['--app-name=cloud-pilot', '--', t, body]];
  return null;
}

export function notificationsOff(env = process.env) {
  return setting('NOTIFY', env) === '0' || setting('NO_TOAST', env) === '1';
}

export function toast(title, text, { dryRun = notificationsOff(), platform = process.platform, run = spawn } = {}) {
  if (dryRun) return false;
  const cmd = notifyCommand(title, text, platform);
  if (!cmd) return false;
  try {
    // The tool by its full path and from the home folder: never one that sits in the folder the hub was started from.
    const child = run(resolveSystemExe(cmd[0], { platform }), cmd[1], { stdio: 'ignore', windowsHide: true, detached: true, cwd: safeCwd() });
    child.on?.('error', () => {}); // the tool is not installed: nothing to show, nothing to crash
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
