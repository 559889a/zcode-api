#
# free-port.ps1 — free the proxy server port from a STALE instance of this
# proxy before start.cmd launches a fresh one (the EADDRINUSE case: an old
# serve still running while the operator thinks it stopped).
#
# Safety: only a process that is BOTH bun.exe AND running src\index.ts is
# ever killed — a foreign tool holding the port is reported and left alone
# (the server start will fail loudly on it instead).
#
param([int]$Port = 8080)

$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
if (-not $listeners) { exit 0 }

foreach ($pid0 in $listeners) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$pid0" -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    if ($proc.Name -eq 'bun.exe' -and $proc.CommandLine -match 'src[\\/]index\.ts') {
        Stop-Process -Id $proc.ProcessId -Force
        Write-Host ("[start] killed stale proxy instance (pid {0}) holding port {1}" -f $proc.ProcessId, $Port)
        Start-Sleep -Milliseconds 800
    } else {
        Write-Host ("[start] port {0} held by {1} (pid {2}) -- not a zcode-proxy instance, leaving it alone" -f $Port, $proc.Name, $proc.ProcessId)
    }
}
