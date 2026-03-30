/**
 * Vault Keychain Adapter — OS-native secret storage for the vault master key.
 *
 * Storage precedence:
 *   1. BOSUN_VAULT_KEY env var (hex string, 32 bytes) — CI / container override
 *   2. Windows Credential Manager (via PowerShell)
 *   3. macOS Keychain (via `security` CLI)
 *   4. Linux Secret Service (via `secret-tool` CLI)
 *
 * All operations are synchronous (execSync) to keep callers simple.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const SERVICE_NAME = "bosun-vault";
const ACCOUNT_NAME = "master-key";

// ─── Platform detection ────────────────────────────────────────────────────────

function platform() {
  return process.platform; // "win32" | "darwin" | "linux"
}

// ─── Windows Credential Manager ───────────────────────────────────────────────

function winRead() {
  try {
    const ps = `
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
$cred = Get-StoredCredential -Target '${SERVICE_NAME}' -ErrorAction SilentlyContinue
if ($cred) { $cred.GetNetworkCredential().Password } else { '' }
`.trim();
    // Try CredentialManager module first (may not be installed)
    const result = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8", timeout: 10_000 }
    ).trim();
    return result || null;
  } catch {
    return winReadFallback();
  }
}

function winReadFallback() {
  try {
    // Use Windows Credential Manager via DPAPI directly
    const ps = `
Add-Type -AssemblyName System.Security
$cm = [System.Security.Cryptography.ProtectedData]
try {
  $target = '${SERVICE_NAME}/${ACCOUNT_NAME}'
  $cred = [System.Net.CredentialCache]::DefaultNetworkCredentials
  # Fall back: read from generic credential store
  $sig = @'
[DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool CredRead(string target, uint type, int reservedFlag, out IntPtr credentialPtr);
[DllImport("advapi32.dll")]
public static extern void CredFree([In] IntPtr cred);
'@
  $WinCred = Add-Type -MemberDefinition $sig -Namespace "WinCred" -Name "NativeMethods" -PassThru
  $credPtr = [IntPtr]::Zero
  if ($WinCred::CredRead($target, 1, 0, [ref]$credPtr)) {
    $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($credPtr, [type][System.Net.NetworkCredential])
    Write-Output $cred.Password
  $WinCred::CredFree($credPtr)
  }
} catch { }
`.trim();
    const result = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8", timeout: 10_000 }
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

function winWrite(hexKey) {
  try {
    const ps = `
$target = '${SERVICE_NAME}/${ACCOUNT_NAME}'
$pass = ConvertTo-SecureString $env:BOSUN_VAULT_HEXKEY -AsPlainText -Force
$cred = New-Object System.Management.Automation.PSCredential ($target, $pass)
Add-Type -AssemblyName System.Security
$sig = @'
[DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
public struct CREDENTIAL {
  public uint Flags; public uint Type; public string TargetName;
  public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
  public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
}
'@
$WinCred = Add-Type -MemberDefinition $sig -Namespace "WinCred2" -Name "NativeMethods" -PassThru
$blob = [System.Text.Encoding]::Unicode.GetBytes($env:BOSUN_VAULT_HEXKEY)
$blobPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($blob.Length)
[System.Runtime.InteropServices.Marshal]::Copy($blob, 0, $blobPtr, $blob.Length)
$credential = New-Object WinCred2.NativeMethods+CREDENTIAL
$credential.TargetName = $target; $credential.UserName = 'bosun'; $credential.Type = 1
$credential.Persist = 2; $credential.CredentialBlob = $blobPtr; $credential.CredentialBlobSize = $blob.Length
$WinCred::CredWrite([ref]$credential, 0) | Out-Null
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr)
`.trim();
    execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env, BOSUN_VAULT_HEXKEY: hexKey },
      }
    );
    return true;
  } catch {
    return false;
  }
}

// ─── macOS Keychain ────────────────────────────────────────────────────────────

function macRead() {
  try {
    const result = execFileSync(
      "security",
      ["find-generic-password", "-s", SERVICE_NAME, "-a", ACCOUNT_NAME, "-w"],
      { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

function macWrite(hexKey) {
  try {
    // Delete existing first to avoid duplicate errors
    try {
      execFileSync(
        "security",
        ["delete-generic-password", "-s", SERVICE_NAME, "-a", ACCOUNT_NAME],
        { timeout: 5_000, stdio: "ignore" }
      );
    } catch { /* not found — ok */ }
    execFileSync(
      "security",
      ["add-generic-password", "-s", SERVICE_NAME, "-a", ACCOUNT_NAME, "-w", hexKey],
      { encoding: "utf8", timeout: 10_000, stdio: "ignore" }
    );
    return true;
  } catch {
    return false;
  }
}

// ─── Linux Secret Service (secret-tool) ───────────────────────────────────────

function linuxRead() {
  try {
    const result = execFileSync(
      "secret-tool",
      ["lookup", "service", SERVICE_NAME, "account", ACCOUNT_NAME],
      { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

function linuxWrite(hexKey) {
  try {
    execFileSync(
      "secret-tool",
      ["store", "--label=Bosun Vault Master Key", "service", SERVICE_NAME, "account", ACCOUNT_NAME],
      {
        input: hexKey,
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["pipe", "ignore", "ignore"],
      }
    );
    return true;
  } catch {
    return false;
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Read the vault master key from the OS keychain (or env var).
 * Returns a 32-byte Buffer or null if not found.
 */
export function keychainRead() {
  // Highest-priority override: env var
  if (process.env.BOSUN_VAULT_KEY) {
    const buf = Buffer.from(process.env.BOSUN_VAULT_KEY, "hex");
    if (buf.length === 32) return buf;
  }

  let hex = null;
  if (platform() === "win32") hex = winRead();
  else if (platform() === "darwin") hex = macRead();
  else hex = linuxRead();

  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, "hex");
}

/**
 * Write the vault master key to the OS keychain.
 * @param {Buffer} key — 32-byte key
 * @returns {boolean} true on success
 */
export function keychainWrite(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("Key must be a 32-byte Buffer");
  }
  const hex = key.toString("hex");
  if (platform() === "win32") return winWrite(hex);
  if (platform() === "darwin") return macWrite(hex);
  return linuxWrite(hex);
}

/**
 * Generate a new random 32-byte master key and store it in the OS keychain.
 * @returns {Buffer} the new key
 */
export function keychainGenerateAndStore() {
  const key = randomBytes(32);
  const ok = keychainWrite(key);
  if (!ok) {
    throw new Error(
      "Failed to store vault key in OS keychain. " +
      "Set BOSUN_VAULT_KEY env var (64-char hex) as a fallback."
    );
  }
  return key;
}

/**
 * Attempt to read the key; generate and store a new one if not found.
 * Useful for first-run setup.
 * @returns {{ key: Buffer, created: boolean }}
 */
export function keychainGetOrCreate() {
  const existing = keychainRead();
  if (existing) return { key: existing, created: false };
  const key = keychainGenerateAndStore();
  return { key, created: true };
}

