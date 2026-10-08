# Quick REST smoke test for the Pingio relay-server (Windows / PowerShell).
# Uses Invoke-RestMethod, so no `jq` or curl required.
#
# Prereqs: relay-server running on $RelayUrl (default http://localhost:5000).
# Usage:   pwsh -File .\test-messaging.ps1
#
# NOTE: Direct messaging is NOT a REST endpoint in this system — it is sent over the
#       WebSocket (`/ws`, message type "message"). This script therefore only exercises
#       the REST surface: registration, contacts (mutual add), and contact listing.

$ErrorActionPreference = 'Stop'
$RelayUrl = if ($env:RELAY_URL) { $env:RELAY_URL } else { 'http://localhost:5000' }

# Unique suffix so the script is re-runnable without username collisions.
$sfx   = (Get-Date -Format 'HHmmss')
$alice = "alice_$sfx"
$bob   = "bob_$sfx"

function Post($path, $body, $token) {
  $headers = @{ 'Content-Type' = 'application/json' }
  if ($token) { $headers['Authorization'] = "Bearer $token" }
  Invoke-RestMethod -Method Post -Uri "$RelayUrl$path" -Headers $headers -Body ($body | ConvertTo-Json)
}
function Get_($path, $token) {
  Invoke-RestMethod -Method Get -Uri "$RelayUrl$path" -Headers @{ Authorization = "Bearer $token" }
}

Write-Host "=== Relay: $RelayUrl ===" -ForegroundColor Cyan

Write-Host "`n=== Registering $alice ===" -ForegroundColor Cyan
$aResp = Post '/api/auth/register' @{ username=$alice; password='SecurePass123!'; deviceFingerprint="$alice-device-1"; deviceName='Alice Laptop' }
$aResp | ConvertTo-Json -Depth 5
$aTok = $aResp.token; $aId = $aResp.userId

Write-Host "`n=== Registering $bob ===" -ForegroundColor Cyan
$bResp = Post '/api/auth/register' @{ username=$bob; password='SecurePass123!'; deviceFingerprint="$bob-device-1"; deviceName='Bob Desktop' }
$bResp | ConvertTo-Json -Depth 5
$bTok = $bResp.token; $bId = $bResp.userId

Write-Host "`n=== $alice adds $bob as contact ===" -ForegroundColor Cyan
Post '/api/contacts' @{ username=$bob } $aTok | ConvertTo-Json -Depth 5

Write-Host "`n=== $bob adds $alice as contact (now mutual) ===" -ForegroundColor Cyan
Post '/api/contacts' @{ username=$alice } $bTok | ConvertTo-Json -Depth 5

Write-Host "`n=== $alice lists contacts (should include $bob) ===" -ForegroundColor Cyan
Get_ '/api/contacts' $aTok | ConvertTo-Json -Depth 5

Write-Host "`n=== Smoke test complete ===" -ForegroundColor Green
Write-Host "Alice ($alice) id=$aId" -ForegroundColor DarkGray
Write-Host "Bob   ($bob) id=$bId"   -ForegroundColor DarkGray
Write-Host "(Direct messaging is exercised over the /ws WebSocket, not REST — see note at top.)" -ForegroundColor DarkGray
