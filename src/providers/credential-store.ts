import { spawnSync } from 'node:child_process';

export interface CredentialStore {
  readonly kind: 'windows-credential-manager' | 'unsupported';
  isSupported(): boolean;
  readSecret(target: string): string | null;
  writeSecret(target: string, secret: string): void;
}

interface PowerShellRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | undefined;
}

type PowerShellRunner = (script: string, env: NodeJS.ProcessEnv) => PowerShellRunResult;

const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'

$source = @"
using System;
using System.Runtime.InteropServices;

public static class PuebloCredMan {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] UInt32 flags);

  [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 reservedFlag, out IntPtr credentialPtr);

  [DllImport("Advapi32.dll", EntryPoint = "CredFree", SetLastError = true)]
  public static extern void CredFree([In] IntPtr cred);
}
"@

Add-Type -TypeDefinition $source

$operation = $env:PUEBLO_CREDENTIAL_OPERATION
$target = $env:PUEBLO_CREDENTIAL_TARGET

if ([string]::IsNullOrWhiteSpace($target)) {
  throw 'Credential target is required.'
}

if ($operation -eq 'read') {
  $credentialPtr = [IntPtr]::Zero
  $found = [PuebloCredMan]::CredRead($target, 1, 0, [ref]$credentialPtr)

  if (-not $found) {
    $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()

    if ($lastError -eq 1168) {
      [Console]::Out.Write('')
      exit 0
    }

    throw "Credential read failed with Win32 error $lastError"
  }

  try {
    $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($credentialPtr, [type][PuebloCredMan+CREDENTIAL])

    if ($credential.CredentialBlob -eq [IntPtr]::Zero -or $credential.CredentialBlobSize -eq 0) {
      [Console]::Out.Write('')
      exit 0
    }

    $bytes = New-Object byte[] $credential.CredentialBlobSize
    [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, [int]$credential.CredentialBlobSize)
    $secret = [Text.Encoding]::Unicode.GetString($bytes)
    [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($secret)))
  } finally {
    [PuebloCredMan]::CredFree($credentialPtr)
  }

  exit 0
}

if ($operation -eq 'write') {
  $secret = $env:PUEBLO_CREDENTIAL_SECRET

  if ($null -eq $secret) {
    throw 'Credential secret is required for write operations.'
  }

  $bytes = [Text.Encoding]::Unicode.GetBytes($secret)
  $secretPtr = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)

  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $secretPtr, $bytes.Length)

    $credential = New-Object PuebloCredMan+CREDENTIAL
    $credential.Type = 1
    $credential.TargetName = $target
    $credential.CredentialBlobSize = [uint32]$bytes.Length
    $credential.CredentialBlob = $secretPtr
    $credential.Persist = 2
    $credential.UserName = 'pueblo'

    $written = [PuebloCredMan]::CredWrite([ref]$credential, 0)
    if (-not $written) {
      $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "Credential write failed with Win32 error $lastError"
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeCoTaskMem($secretPtr)
  }

  exit 0
}

throw "Unsupported credential operation: $operation"
`;

export class UnsupportedCredentialStore implements CredentialStore {
  readonly kind = 'unsupported';

  isSupported(): boolean {
    return false;
  }

  readSecret(): string | null {
    return null;
  }

  writeSecret(): void {
    throw new Error('Credential storage is not supported on this platform.');
  }
}

export class WindowsCredentialManagerStore implements CredentialStore {
  readonly kind = 'windows-credential-manager';

  constructor(
    private readonly runner: PowerShellRunner = defaultPowerShellRunner,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  isSupported(): boolean {
    return this.platform === 'win32';
  }

  readSecret(target: string): string | null {
    this.ensureSupported();
    const result = this.runner(WINDOWS_CREDENTIAL_SCRIPT, {
      ...process.env,
      PUEBLO_CREDENTIAL_OPERATION: 'read',
      PUEBLO_CREDENTIAL_TARGET: target,
    });

    if (result.status !== 0) {
      throw new Error(result.stderr || result.error?.message || 'Failed to read Windows credential.');
    }

    const encoded = result.stdout.trim();
    if (!encoded) {
      return null;
    }

    return Buffer.from(encoded, 'base64').toString('utf8');
  }

  writeSecret(target: string, secret: string): void {
    this.ensureSupported();
    const result = this.runner(WINDOWS_CREDENTIAL_SCRIPT, {
      ...process.env,
      PUEBLO_CREDENTIAL_OPERATION: 'write',
      PUEBLO_CREDENTIAL_TARGET: target,
      PUEBLO_CREDENTIAL_SECRET: secret,
    });

    if (result.status !== 0) {
      throw new Error(result.stderr || result.error?.message || 'Failed to write Windows credential.');
    }
  }

  private ensureSupported(): void {
    if (!this.isSupported()) {
      throw new Error('Windows Credential Manager is only supported on Windows.');
    }
  }
}

export function createDefaultCredentialStore(platform: NodeJS.Platform = process.platform): CredentialStore {
  if (platform === 'win32') {
    return new WindowsCredentialManagerStore(undefined, platform);
  }

  return new UnsupportedCredentialStore();
}

function defaultPowerShellRunner(script: string, env: NodeJS.ProcessEnv): PowerShellRunResult {
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
    {
      encoding: 'utf8',
      env,
      windowsHide: true,
    },
  );

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}