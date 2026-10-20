import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Proof that a person at this computer approved something: a fingerprint, a face, a PIN or the
 * account password, asked for by the operating system. A click in a RaSQL window is not proof;
 * any program that drives the mouse can make one (docs/DECISIONS.md D-43).
 *
 * One provider per platform. Each runs a tool the OS ships, so no native module is needed.
 */
export interface PresenceCheck {
  readonly id: string;
  /** How the prompt names the method: "Touch ID or your password". */
  readonly label: string;
  available(): Promise<boolean>;
  /** Resolves true when the OS confirmed the user, false when they cancelled or failed. */
  verify(reason: string): Promise<boolean>;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: opts.env ?? process.env, timeout: opts.timeoutMs ?? 0, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        resolve({ code, stdout: String(stdout).trim(), stderr: String(stderr).trim() });
      },
    );
  });
}

// macOS ------------------------------------------------------------------------------------

/**
 * LocalAuthentication's device-owner policy: Touch ID or Apple Watch when present, the account
 * password otherwise or on request. Run through osascript, because Electron's own
 * promptTouchID allows biometrics only and fails on Macs without a usable sensor.
 */
const MAC_SCRIPT = `
function run(argv) {
  ObjC.import('LocalAuthentication');
  ObjC.import('Foundation');
  const ctx = $.LAContext.alloc.init;
  const DEVICE_OWNER = 2;
  if (argv[0] === 'check') return ctx.canEvaluatePolicyError(DEVICE_OWNER, null) ? 'yes' : 'no';
  let done = false, ok = false;
  ctx.evaluatePolicyLocalizedReasonReply(DEVICE_OWNER, argv[1], (success) => {
    ok = success;
    done = true;
  });
  while (!done) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
  return ok ? 'ok' : 'fail';
}`;

const OSASCRIPT = '/usr/bin/osascript';

export const macPresence: PresenceCheck = {
  id: 'macos-local-authentication',
  label: 'Touch ID or your password',
  async available() {
    if (!existsSync(OSASCRIPT)) return false;
    const r = await run(OSASCRIPT, ['-l', 'JavaScript', '-e', MAC_SCRIPT, 'check'], {
      timeoutMs: 10_000,
    });
    return r.stdout === 'yes';
  },
  async verify(reason) {
    const r = await run(OSASCRIPT, ['-l', 'JavaScript', '-e', MAC_SCRIPT, 'verify', reason]);
    return r.code === 0 && r.stdout === 'ok';
  },
};

// Windows ----------------------------------------------------------------------------------

/**
 * Windows Hello (PIN, face or fingerprint) through the WinRT UserConsentVerifier. When Hello is
 * not set up or will not start, the Windows Security password dialog for the signed-in user,
 * with the password checked by LogonUser and never kept. Runs in Windows PowerShell 5.1, which
 * ships with Windows and can still load WinRT types (PowerShell 7 cannot).
 */
const WIN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$mode = $env:RASQL_PRESENCE_MODE
$reason = $env:RASQL_PRESENCE_REASON
$hello = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' } | Select-Object -First 1
  function Await($op, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }
  $ucv = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
  $availability = Await ($ucv::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability, Windows.Security.Credentials.UI, ContentType = WindowsRuntime])
  if ("$availability" -eq 'Available') { $hello = $ucv }
} catch { $hello = $null }

if ($mode -eq 'check') { if ($hello) { 'hello' } else { 'password' }; exit 0 }

if ($hello) {
  try {
    $result = Await ($hello::RequestVerificationAsync($reason)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult, Windows.Security.Credentials.UI, ContentType = WindowsRuntime])
    if ("$result" -eq 'Verified') { 'ok'; exit 0 }
    if ("$result" -eq 'Canceled' -or "$result" -eq 'RetriesExhausted') { 'fail'; exit 1 }
  } catch { }
  # Hello is set up but could not run: fall through to the password.
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RasqlPresence {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDUI_INFO { public int cbSize; public IntPtr hwndParent; public string pszMessageText; public string pszCaptionText; public IntPtr hbmBanner; }
  [DllImport("credui.dll", CharSet = CharSet.Unicode)]
  static extern int CredUIPromptForWindowsCredentials(ref CREDUI_INFO info, int authError, ref uint authPackage, IntPtr inBuffer, uint inSize, out IntPtr outBuffer, out uint outSize, ref bool save, int flags);
  [DllImport("credui.dll", CharSet = CharSet.Unicode)]
  static extern bool CredUnPackAuthenticationBuffer(int flags, IntPtr buffer, uint size, StringBuilder user, ref int userLength, StringBuilder domain, ref int domainLength, StringBuilder password, ref int passwordLength);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool LogonUser(string user, string domain, string password, int logonType, int provider, out IntPtr token);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr p);
  const int CREDUIWIN_ENUMERATE_CURRENT_USER = 0x200;
  const int LOGON32_LOGON_INTERACTIVE = 2;
  public static bool Verify(string message) {
    var info = new CREDUI_INFO { cbSize = Marshal.SizeOf(typeof(CREDUI_INFO)), pszCaptionText = "RaSQL", pszMessageText = message };
    uint package = 0; IntPtr buffer; uint size; bool save = false;
    if (CredUIPromptForWindowsCredentials(ref info, 0, ref package, IntPtr.Zero, 0, out buffer, out size, ref save, CREDUIWIN_ENUMERATE_CURRENT_USER) != 0) return false;
    try {
      var user = new StringBuilder(514); var domain = new StringBuilder(338); var password = new StringBuilder(258);
      int ul = user.Capacity, dl = domain.Capacity, pl = password.Capacity;
      if (!CredUnPackAuthenticationBuffer(0, buffer, size, user, ref ul, domain, ref dl, password, ref pl)) return false;
      string u = user.ToString(); string d = domain.ToString();
      int slash = u.IndexOf('\\');
      if (slash >= 0) { d = u.Substring(0, slash); u = u.Substring(slash + 1); }
      // The dialog lists only the signed-in user; a typed-in other account does not count.
      if (u.IndexOf('@') < 0 && !string.Equals(u, Environment.UserName, StringComparison.OrdinalIgnoreCase)) return false;
      IntPtr token;
      bool ok = LogonUser(u, d.Length == 0 ? null : d, password.ToString(), LOGON32_LOGON_INTERACTIVE, 0, out token);
      password.Clear();
      if (ok) CloseHandle(token);
      return ok;
    } finally {
      CoTaskMemFree(buffer);
    }
  }
}
'@
if ([RasqlPresence]::Verify($reason)) { 'ok'; exit 0 } else { 'fail'; exit 1 }
`;

const powershell = (): string =>
  join(
    process.env['SystemRoot'] ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );

async function winRun(mode: 'check' | 'verify', reason = ''): Promise<Run> {
  // -EncodedCommand takes UTF-16LE base64, so the script needs no quoting; the reason travels
  // in the environment, never inside the script text.
  const encoded = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64');
  return run(
    powershell(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    {
      env: { ...process.env, RASQL_PRESENCE_MODE: mode, RASQL_PRESENCE_REASON: reason },
      timeoutMs: mode === 'check' ? 20_000 : 0,
    },
  );
}

export function windowsPresence(): PresenceCheck {
  let label = 'Windows Hello or your password';
  return {
    id: 'windows-hello',
    get label() {
      return label;
    },
    async available() {
      if (!existsSync(powershell())) return false;
      const r = await winRun('check');
      if (r.stdout === 'hello') label = 'Windows Hello';
      else if (r.stdout === 'password') label = 'your Windows password';
      else return false;
      return true;
    },
    async verify(reason) {
      const r = await winRun('verify', reason);
      return r.code === 0 && r.stdout.endsWith('ok');
    },
  };
}

// Linux ------------------------------------------------------------------------------------

/** Installed by the .deb, or by hand from packages/app/build/linux. */
export const POLKIT_ACTION = 'nl.remonpel.rasql.approve-agent-change';
const POLKIT_POLICY = `/usr/share/polkit-1/actions/${POLKIT_ACTION.replace(/\.approve-agent-change$/, '')}.policy`;

const which = (name: string): string | undefined =>
  ['/usr/bin', '/bin', '/usr/local/bin'].map((d) => join(d, name)).find((p) => existsSync(p));

/**
 * polkit, through the desktop's authentication agent (GNOME, KDE and others), which also offers
 * the fingerprint where fprintd is set up. With RaSQL's own action installed it asks the user
 * to confirm themselves (auth_self, every time). Without it, pkexec running /usr/bin/true asks
 * for an administrator's password: clumsier wording, the same proof for a desktop user.
 */
export function linuxPresence(): PresenceCheck {
  let label = 'your password';
  return {
    id: 'linux-polkit',
    get label() {
      return label;
    },
    async available() {
      if (which('pkcheck') && existsSync(POLKIT_POLICY)) {
        label = 'your password';
        return true;
      }
      if (which('pkexec') && which('true')) {
        label = 'an administrator password';
        return true;
      }
      return false;
    },
    async verify() {
      const pkcheck = which('pkcheck');
      if (pkcheck && existsSync(POLKIT_POLICY)) {
        const r = await run(pkcheck, [
          '--action-id',
          POLKIT_ACTION,
          '--process',
          String(process.pid),
          '--allow-user-interaction',
        ]);
        return r.code === 0;
      }
      const pkexec = which('pkexec');
      const truePath = which('true');
      if (!pkexec || !truePath) return false;
      return (await run(pkexec, [truePath])).code === 0;
    },
  };
}

// Choice -----------------------------------------------------------------------------------

const none: PresenceCheck = {
  id: 'none',
  label: 'a system check',
  available: async () => false,
  verify: async () => false,
};

/** The provider for this platform. Tests and future platforms replace it here. */
export function presenceForPlatform(platform: NodeJS.Platform = process.platform): PresenceCheck {
  if (platform === 'darwin') return macPresence;
  if (platform === 'win32') return windowsPresence();
  if (platform === 'linux') return linuxPresence();
  return none;
}

/** Remembers availability for a minute: a lid closing or a reader unplugging can change it. */
export function cached(check: PresenceCheck, ttlMs = 60_000): PresenceCheck {
  let last: { at: number; value: boolean } | null = null;
  return {
    id: check.id,
    get label() {
      return check.label;
    },
    async available() {
      if (last && Date.now() - last.at < ttlMs) return last.value;
      const value = await check.available().catch(() => false);
      last = { at: Date.now(), value };
      return value;
    },
    verify: (reason) => check.verify(reason),
  };
}
