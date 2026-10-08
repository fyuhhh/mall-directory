# backup.ps1 — backup DB + media + arsip rilis (§8.6), Windows (XAMPP).
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\backup.ps1 [-Dest D:\bsb-backup]
# Retensi: 14 harian + 8 mingguan (Minggu) + 12 bulanan (tgl 1). Off-site: Google Drive for Desktop / rclone.
param(
  [string]$Dest = $(if ($env:BSB_BACKUP_DIR) { $env:BSB_BACKUP_DIR } else { 'D:\bsb-backup' }),
  [string]$Php = $(if ($env:PHP_BIN) { $env:PHP_BIN } else { 'C:\xampp\php\php.exe' })
)
$ErrorActionPreference = 'Stop'
$App = Split-Path -Parent $PSScriptRoot
function Cfg([string]$k) { & $Php -r 'require $argv[1]."/lib/bootstrap.php"; $v=Config::get($argv[2]); echo is_scalar($v)?$v:"";' $App $k }
$dbName = Cfg 'db.name'; $dbUser = Cfg 'db.user'; $dbPass = Cfg 'db.pass'; $dbHost = Cfg 'db.host'
$dump = Cfg 'mysqldump'
if (-not (Test-Path $dump)) { $dump = 'C:\xampp\mysql\bin\mysqldump.exe' }
$ts = Get-Date -Format 'yyyyMMdd_HHmm'
foreach ($d in 'db\daily','db\weekly','db\monthly','media','releases') { New-Item -ItemType Directory -Force -Path (Join-Path $Dest $d) | Out-Null }
$sql = Join-Path $Dest "db\daily\bsb_$ts.sql"
$dumpArgs = @("-u$dbUser", "-h$dbHost", '--single-transaction', '--routines', '--default-character-set=utf8mb4', "--result-file=$sql", $dbName)
if ($dbPass) { $dumpArgs = @("-p$dbPass") + $dumpArgs }
& $dump @args 2>$null
if ($LASTEXITCODE -ne 0) {
  # tabel mysql.proc lama (error 1558) → ulang tanpa --routines (skema tidak memakai routine)
  $dumpArgs = $dumpArgs | Where-Object { $_ -ne '--routines' }
  & $dump @args
  if ($LASTEXITCODE -ne 0) { throw "mysqldump gagal ($LASTEXITCODE)" }
}
if (-not ((Get-Content $sql -Tail 3) -match 'Dump completed')) { throw 'dump tidak lengkap' }
# gzip
$gz = "$sql.gz"
$in = [IO.File]::OpenRead($sql); $out = [IO.File]::Create($gz)
$z = New-Object IO.Compression.GZipStream($out, [IO.Compression.CompressionLevel]::Optimal)
$in.CopyTo($z); $z.Dispose(); $out.Dispose(); $in.Dispose(); Remove-Item $sql
if ((Get-Date).DayOfWeek -eq 'Sunday') { Copy-Item $gz (Join-Path $Dest 'db\weekly') }
if ((Get-Date).Day -eq 1) { Copy-Item $gz (Join-Path $Dest 'db\monthly') }
# mirror inkremental
robocopy (Join-Path $App 'media') (Join-Path $Dest 'media') /MIR /XD tmp /NFL /NDL /NJH /NJS /NP | Out-Null
robocopy (Join-Path $App 'data\releases') (Join-Path $Dest 'releases') /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy gagal ($LASTEXITCODE)" }
# retensi
function Prune($dir, $keep) { Get-ChildItem (Join-Path $Dest $dir) -Filter 'bsb_*.sql.gz' | Sort-Object LastWriteTime -Descending | Select-Object -Skip $keep | Remove-Item -Force }
Prune 'db\daily' 14; Prune 'db\weekly' 8; Prune 'db\monthly' 12
Write-Output "backup OK: $gz -> $Dest"
exit 0
