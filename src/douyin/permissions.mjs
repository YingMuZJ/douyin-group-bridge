import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// Build the complete DACL in memory, then apply it once. The upstream icacls
// sequence removed inherited access before its localized account names had
// been resolved, leaving this Windows installation with an empty DACL.
export function protectStateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, 0o700);
    return;
  }
  const script = `
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$target = [System.IO.Path]::GetFullPath($env:DOUYIN_BRIDGE_ACL_TARGET)
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if (-not $identity) { throw 'Cannot determine current Windows identity' }
$acl = Get-Acl -LiteralPath $target
$acl.SetAccessRuleProtection($true, $false)
foreach ($entry in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($entry) }
foreach ($sid in @($identity, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $target -AclObject $acl
`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 20000, stdio: 'pipe',
    env: { ...process.env, DOUYIN_BRIDGE_ACL_TARGET: dir },
  });
  fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
}
