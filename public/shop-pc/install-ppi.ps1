# PPI shop PC installer (Windows 10/11).
#
# Sets up the shop PC so PPI can fetch the shop's stock file:
#   C:\PPI\export   the shop's stock software writes its export here (e.g. stock.xml)
#   C:\PPI\serve    finished copies of those files (never a half-written file)
#   C:\PPI\bin      rclone, cloudflared, the PPI agent and the rclone login (admins only)
#   C:\PPI\logs     logs
#
# "PPI file server" (Task Scheduler, runs as SYSTEM at startup) copies finished
# exports to C:\PPI\serve and runs "rclone serve http" read-only on 127.0.0.1:8081
# with a username and password. cloudflared (Windows service) connects the PC to
# its Cloudflare tunnel; Cloudflare Access only lets PPI's service token through.
# No router ports are opened.
#
# Run in PowerShell "as Administrator":
#   powershell -ExecutionPolicy Bypass -File install-ppi.ps1
# Later runs: C:\PPI\bin\install-ppi.ps1 (the installer keeps a copy there).
# Options:
#   -TunnelToken <token>  the Cloudflare tunnel token (asked for if missing)
#   -Hostname <host>      the shop's tunnel address, e.g. shop-name.example.com (checks Cloudflare Access)
#   -SampleFile           put a small test file into C:\PPI\export (for a rehearsal)
#   -ShowLogin            show the rclone username and password again
#   -NewPassword          make a new rclone password (enter it in PPI admin afterwards)
#   -Update               download rclone and cloudflared again
#   -Uninstall            remove everything except C:\PPI\export
#
# This file must stay plain ASCII (Windows PowerShell 5.1 reads it as ANSI).

[CmdletBinding()]
param(
  [string]$TunnelToken = "",
  [string]$Hostname = "",
  [int]$Port = 8081,
  [switch]$SampleFile,
  [switch]$ShowLogin,
  [switch]$NewPassword,
  [switch]$Update,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Root = "C:\PPI"
$Export = Join-Path $Root "export"
$Serve = Join-Path $Root "serve"
$Work = Join-Path $Root "work"
$Bin = Join-Path $Root "bin"
$Logs = Join-Path $Root "logs"
$Rclone = Join-Path $Bin "rclone.exe"
$Cloudflared = Join-Path $Bin "cloudflared.exe"
$Agent = Join-Path $Bin "ppi-agent.ps1"
$LoginFile = Join-Path $Bin "login.json"
$TaskName = "PPI file server"

# Well-known SIDs work on every Windows language (Slovak, Hungarian, ...).
$SidSystem = "*S-1-5-18"
$SidAdmins = "*S-1-5-32-544"
$SidUsers = "*S-1-5-32-545"

function Say($text) { Write-Host $text }
function Step($text) { Write-Host ""; Write-Host "== $text" }
function Fail($text) { Write-Host ""; Write-Host "ERROR: $text"; exit 1 }

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function New-Password([int]$length = 32) {
  $chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789".ToCharArray()
  $bytes = New-Object byte[] ($length * 4)
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $out = ""
  for ($i = 0; $i -lt $length; $i++) {
    $value = [BitConverter]::ToUInt32($bytes, $i * 4)
    $out += $chars[$value % $chars.Length]
  }
  return $out
}

# Runs a program; its messages on stderr must not stop the script (Windows PowerShell 5.1).
function Invoke-Native([string]$exe, [string[]]$arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $exe @arguments 2>&1 | ForEach-Object { "$_" } | Out-String
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  return @{ Code = $code; Output = "$output".Trim() }
}

function Stop-PpiProcesses {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*ppi-agent.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-Process -Name rclone -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $Rclone } |
    Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

# Returns the HTTP status of a GET without following redirects (0 = no connection).
function Get-HttpStatus([string]$url, [hashtable]$headers = @{}) {
  try {
    $request = [Net.HttpWebRequest]::Create($url)
    $request.Method = "GET"
    $request.AllowAutoRedirect = $false
    $request.Timeout = 15000
    foreach ($key in $headers.Keys) { $request.Headers.Add($key, $headers[$key]) }
    $response = $request.GetResponse()
    $status = [int]$response.StatusCode
    $response.Close()
    return $status
  } catch {
    $e = $_.Exception
    while ($e -and -not ($e -is [Net.WebException])) { $e = $e.InnerException }
    if ($e -and $e.Response) {
      $status = [int]$e.Response.StatusCode
      $e.Response.Close()
      return $status
    }
    return 0
  }
}

function Get-BasicHeader($login) {
  $pair = [Text.Encoding]::UTF8.GetBytes("$($login.user):$($login.password)")
  return @{ Authorization = "Basic " + [Convert]::ToBase64String($pair) }
}

function Show-Login($login) {
  Say ""
  Say "  rclone username:  $($login.user)"
  Say "  rclone password:  $($login.password)"
  Say ""
  Say "  Type these into PPI admin > the shop > 'Pristup k suboru' (rclone user / password)"
  Say "  or keep them in your password manager. Do not send them by e-mail or chat."
}

# --------------------------------------------------------------------------

if (-not (Test-Admin)) {
  Fail "Run PowerShell as Administrator (right-click > Run as administrator) and start this script again."
}

if ($ShowLogin) {
  if (-not (Test-Path $LoginFile)) { Fail "PPI is not installed on this PC yet." }
  Show-Login (Get-Content -Raw $LoginFile | ConvertFrom-Json)
  exit 0
}

if ($Uninstall) {
  Step "Removing PPI (the folder C:\PPI\export is kept)"
  Stop-PpiProcesses
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  if ((Get-Service -Name cloudflared -ErrorAction SilentlyContinue) -and (Test-Path $Cloudflared)) {
    Invoke-Native $Cloudflared @("service", "uninstall") | Out-Null
  }
  foreach ($dir in @($Serve, $Work, $Bin, $Logs)) {
    if (Test-Path $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
  }
  Say "Done. Also delete this shop's tunnel and service token in Cloudflare."
  exit 0
}

$arch = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
switch ($arch) {
  "AMD64" { $rcloneArch = "amd64"; $cfArch = "amd64" }
  "ARM64" { $rcloneArch = "arm64"; $cfArch = "amd64" }
  "x86"   { $rcloneArch = "386";   $cfArch = "386" }
  default { Fail "Unsupported processor: $arch" }
}

Step "Folders"
foreach ($dir in @($Root, $Export, $Serve, $Work, $Bin, $Logs)) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
}
# The shop software (running as the shop's user) may write the export folder.
Invoke-Native "icacls.exe" @($Export, "/grant", "${SidUsers}:(OI)(CI)M") | Out-Null
# Programs and the rclone login: only SYSTEM and administrators.
$acl = Invoke-Native "icacls.exe" @($Bin, "/inheritance:r", "/grant:r", "${SidSystem}:(OI)(CI)F", "${SidAdmins}:(OI)(CI)F")
if ($acl.Code -ne 0) { Fail "Could not protect $Bin`n$($acl.Output)" }
Say "  $Export  <- set the shop's stock software to export here"
# Keep a copy of this script for later runs (-ShowLogin, -Update, ...).
$SelfCopy = Join-Path $Bin "install-ppi.ps1"
if ($PSCommandPath -and $PSCommandPath -ne $SelfCopy) { Copy-Item -LiteralPath $PSCommandPath -Destination $SelfCopy -Force }

Stop-PpiProcesses

Step "rclone (file server)"
if ($Update -or -not (Test-Path $Rclone)) {
  $version = (Invoke-WebRequest -UseBasicParsing "https://downloads.rclone.org/version.txt").Content.Trim().Split(" ")[-1]
  if ($version -notmatch "^v\d+\.\d+\.\d+$") { Fail "Could not read the current rclone version." }
  $zipName = "rclone-$version-windows-$rcloneArch.zip"
  $zip = Join-Path $env:TEMP $zipName
  Invoke-WebRequest -UseBasicParsing "https://downloads.rclone.org/$version/$zipName" -OutFile $zip
  $sums = (Invoke-WebRequest -UseBasicParsing "https://downloads.rclone.org/$version/SHA256SUMS").Content
  $expected = ($sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($zipName))\s*$" } | Select-Object -First 1)
  if (-not $expected) { Fail "rclone checksum not found." }
  $expected = $expected.Trim().Split(" ")[0].ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
  if ($expected -ne $actual) { Fail "rclone download is damaged (checksum mismatch). Run the script again." }
  $unpack = Join-Path $env:TEMP "ppi-rclone"
  if (Test-Path $unpack) { Remove-Item -LiteralPath $unpack -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $unpack
  Copy-Item -LiteralPath (Get-ChildItem -LiteralPath $unpack -Recurse -Filter rclone.exe | Select-Object -First 1).FullName -Destination $Rclone -Force
  Remove-Item -LiteralPath $zip, $unpack -Recurse -Force
  Say "  installed rclone $version"
} else {
  Say "  already installed (use -Update to download again)"
}

Step "cloudflared (tunnel)"
if ($Update -or -not (Test-Path $Cloudflared)) {
  $download = Join-Path $env:TEMP "cloudflared-ppi.exe"
  Invoke-WebRequest -UseBasicParsing "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$cfArch.exe" -OutFile $download
  $signature = Get-AuthenticodeSignature -LiteralPath $download
  if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notmatch "Cloudflare") {
    Remove-Item -LiteralPath $download -Force
    Fail "The cloudflared download is not signed by Cloudflare. Run the script again."
  }
  $service = Get-Service -Name cloudflared -ErrorAction SilentlyContinue
  if ($service -and $service.Status -eq "Running") { Stop-Service -Name cloudflared -Force }
  Move-Item -LiteralPath $download -Destination $Cloudflared -Force
  if ($service) { Start-Service -Name cloudflared }
  Say "  installed $((Invoke-Native $Cloudflared @("--version")).Output)"
} else {
  Say "  already installed (use -Update to download again)"
}

Step "rclone login"
if ($NewPassword -or -not (Test-Path $LoginFile)) {
  $login = [ordered]@{ user = "ppi"; password = (New-Password 32); port = $Port }
  ($login | ConvertTo-Json) | Set-Content -LiteralPath $LoginFile -Encoding ASCII
  $login = Get-Content -Raw $LoginFile | ConvertFrom-Json
  $loginChanged = $true
  Say "  new login created"
} else {
  $login = Get-Content -Raw $LoginFile | ConvertFrom-Json
  if ([int]$login.port -ne $Port) {
    $login.port = $Port
    ($login | ConvertTo-Json) | Set-Content -LiteralPath $LoginFile -Encoding ASCII
  }
  $loginChanged = $false
  Say "  keeping the existing login (use -NewPassword for a new one)"
}

Step "PPI file server (starts with Windows)"
$agentCode = @'
# PPI agent: written by install-ppi.ps1, runs as SYSTEM at startup.
# 1. Copies finished stock files from C:\PPI\export to C:\PPI\serve, so PPI never
#    downloads a half-written export (a cut-off list would zero the missing items).
# 2. Keeps "rclone serve http" running: read-only, 127.0.0.1 only, username + password.
$ErrorActionPreference = "Continue"
$Root = "C:\PPI"
$Export = Join-Path $Root "export"
$Serve = Join-Path $Root "serve"
$Work = Join-Path $Root "work"
$Bin = Join-Path $Root "bin"
$Logs = Join-Path $Root "logs"
$LogFile = Join-Path $Logs "agent.log"
$Rclone = Join-Path $Bin "rclone.exe"
$Login = Get-Content -Raw (Join-Path $Bin "login.json") | ConvertFrom-Json
$Extensions = @(".xml", ".csv", ".xlsx", ".txt")
$SettleSeconds = 60
$Waiting = @{}

function Write-Log($message) {
  try {
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) { Move-Item -LiteralPath $LogFile -Destination "$LogFile.old" -Force }
    Add-Content -LiteralPath $LogFile -Value ("{0:u} {1}" -f (Get-Date).ToUniversalTime(), $message)
  } catch {}
}

function Publish-Files {
  foreach ($file in @(Get-ChildItem -LiteralPath $Export -File -ErrorAction SilentlyContinue)) {
    if ($Extensions -notcontains $file.Extension.ToLowerInvariant()) { continue }
    # The export must be untouched for a minute before it is published.
    if (((Get-Date).ToUniversalTime() - $file.LastWriteTimeUtc).TotalSeconds -lt $SettleSeconds) { continue }
    $target = Join-Path $Serve $file.Name
    $current = Get-Item -LiteralPath $target -ErrorAction SilentlyContinue
    if ($current -and $current.LastWriteTimeUtc -eq $file.LastWriteTimeUtc -and $current.Length -eq $file.Length) { continue }
    $temp = Join-Path $Work $file.Name
    $source = $null
    $out = $null
    try {
      # Opening without sharing fails while the stock software still has the file open.
      $source = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
      $out = [IO.File]::Create($temp)
      $source.CopyTo($out)
      $out.Close(); $out = $null
      $source.Close(); $source = $null
      [IO.File]::SetLastWriteTimeUtc($temp, $file.LastWriteTimeUtc)
      if (Test-Path -LiteralPath $target) {
        [IO.File]::Replace($temp, $target, [NullString]::Value)
        [IO.File]::SetLastWriteTimeUtc($target, $file.LastWriteTimeUtc)
      } else {
        [IO.File]::Move($temp, $target)
      }
      $Waiting.Remove($file.Name)
      Write-Log "published $($file.Name) ($($file.Length) bytes, written $($file.LastWriteTimeUtc.ToString('u')))"
    } catch {
      if ($Waiting[$file.Name] -ne $file.LastWriteTimeUtc) {
        $Waiting[$file.Name] = $file.LastWriteTimeUtc
        Write-Log "waiting for $($file.Name): $($_.Exception.Message)"
      }
    } finally {
      if ($out) { $out.Close() }
      if ($source) { $source.Close() }
      if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
    }
  }
}

function Start-FileServer {
  Get-Process -Name rclone -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $Rclone } | Stop-Process -Force -ErrorAction SilentlyContinue
  $arguments = @(
    "serve", "http", $Serve,
    "--addr", "127.0.0.1:$($Login.port)",
    "--read-only",
    "--user", $Login.user,
    "--pass", $Login.password,
    "--dir-cache-time", "5s",
    "--log-file", (Join-Path $Logs "rclone.log"),
    "--log-level", "NOTICE"
  )
  Write-Log "starting rclone on 127.0.0.1:$($Login.port)"
  return Start-Process -FilePath $Rclone -ArgumentList $arguments -WindowStyle Hidden -PassThru
}

Write-Log "agent started"
$server = $null
while ($true) {
  if (-not $server -or $server.HasExited) {
    if ($server) { Write-Log "rclone stopped (exit code $($server.ExitCode)), restarting" }
    try { $server = Start-FileServer } catch { Write-Log "could not start rclone: $($_.Exception.Message)"; $server = $null }
  }
  Publish-Files
  Start-Sleep -Seconds 20
}
'@
Set-Content -LiteralPath $Agent -Value $agentCode -Encoding ASCII

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Agent`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
  -Description "PPI: publishes the stock export and serves it read-only to the PPI tunnel" -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

if ($SampleFile) {
  $sample = "Code;Item name;EAN;Brand;Quantity;Price`r`n" +
    "T001;Coffee beans 1 kg;8000070012345;Lavazza;14;18,90`r`n" +
    "T002;Ground coffee 250 g;8711000012346;Jacobs;2;4,49`r`n" +
    "T003;Milk 1.5% 1 l;8586000012347;Rajo;40;1,09`r`n" +
    "T004;Bread 1 kg;;;0;1,89`r`n" +
    "T005;Green tea 20 bags;8711000012350;Pickwick;12;2,29`r`n"
  Set-Content -LiteralPath (Join-Path $Export "stock.csv") -Value $sample -Encoding ASCII -NoNewline
  Say "  test file written: $Export\stock.csv (published after about a minute)"
}

Say "  checking the file server..."
$status = 0
for ($i = 0; $i -lt 15 -and $status -ne 200; $i++) {
  Start-Sleep -Seconds 2
  $status = Get-HttpStatus "http://127.0.0.1:$Port/" (Get-BasicHeader $login)
}
if ($status -ne 200) { Fail "The file server did not start (HTTP $status). See C:\PPI\logs\agent.log and rclone.log." }
if ((Get-HttpStatus "http://127.0.0.1:$Port/") -ne 401) { Fail "The file server answers without a password. Run the script again." }
Say "  OK: http://127.0.0.1:$Port/ answers, only with the password"

Step "Cloudflare tunnel"
$service = Get-Service -Name cloudflared -ErrorAction SilentlyContinue
if (-not $TunnelToken -and -not $service) {
  Say "  Paste the tunnel token from Cloudflare (the long text starting with eyJ, or the whole"
  Say "  'cloudflared.exe service install ...' line) and press Enter:"
  $TunnelToken = Read-Host "  token"
}
if ($TunnelToken) {
  $match = [regex]::Match($TunnelToken, "eyJ[A-Za-z0-9+/=_-]{40,}")
  if (-not $match.Success) { Fail "That does not look like a tunnel token (it starts with eyJ)." }
  if ($service) {
    Invoke-Native $Cloudflared @("service", "uninstall") | Out-Null
    Start-Sleep -Seconds 2
  }
  $result = Invoke-Native $Cloudflared @("service", "install", $match.Value)
  if ($result.Code -ne 0) { Fail "cloudflared could not install the service:`n$($result.Output)" }
  Start-Sleep -Seconds 3
  $service = Get-Service -Name cloudflared -ErrorAction SilentlyContinue
}
if (-not $service) { Fail "The cloudflared service is missing. Run the script again with the tunnel token." }
if ($service.Status -ne "Running") { Start-Service -Name cloudflared; Start-Sleep -Seconds 3 }
Say "  OK: cloudflared service is $((Get-Service -Name cloudflared).Status)"

if ($Hostname) {
  $Hostname = ($Hostname -replace "^https?://", "").Split("/")[0]
  Step "Checking https://$Hostname/"
  $status = 0
  for ($i = 0; $i -lt 6; $i++) {
    $status = Get-HttpStatus "https://$Hostname/"
    if ($status -ne 0 -and $status -ne 502 -and $status -ne 530) { break }
    Start-Sleep -Seconds 5
  }
  switch ($status) {
    { $_ -eq 302 -or $_ -eq 403 } { Say "  OK: Cloudflare Access blocks visitors without the service token (HTTP $status)." }
    401 { Say "  WARNING: the request reached this PC without a service token. Add the Cloudflare Access application (guide step C3)." }
    200 { Say "  WARNING: the address is open to everyone. Add the Cloudflare Access application (guide step C3)." }
    { $_ -eq 502 -or $_ -eq 530 } { Say "  WARNING: Cloudflare cannot reach this PC (HTTP $status). Check the tunnel's public hostname: http://localhost:$Port" }
    0 { Say "  WARNING: no answer from https://$Hostname/ (address wrong, or DNS not ready yet; try again in a few minutes)." }
    default { Say "  Answer: HTTP $status" }
  }
}

Step "Done"
Say "  The shop's stock software exports to:  $Export  (e.g. stock.xml, every 15-30 minutes)"
Say "  PPI admin > the shop > 'Zdroj zasob' > file address:  https://<tunnel address>/stock.xml"
if ($loginChanged) {
  Show-Login $login
} else {
  Say "  rclone login unchanged. Show it with:"
  Say "    powershell -ExecutionPolicy Bypass -File C:\PPI\bin\install-ppi.ps1 -ShowLogin"
}
Say ""
Say "  Logs: C:\PPI\logs   Re-run C:\PPI\bin\install-ppi.ps1 any time; it keeps the existing login and tunnel."
