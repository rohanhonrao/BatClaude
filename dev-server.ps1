# dev-server.ps1 — tiny local static server for testing BatVault before deploy.
# Usage:  powershell -ExecutionPolicy Bypass -File dev-server.ps1
# Then open http://localhost:4599/  (ES modules & the service worker need http, not file://)
param([int]$Port = 4599, [string]$Root = $PSScriptRoot)

$mime = @{
  ".html"="text/html; charset=utf-8"; ".js"="text/javascript; charset=utf-8";
  ".css"="text/css; charset=utf-8"; ".json"="application/json; charset=utf-8";
  ".webmanifest"="application/manifest+json; charset=utf-8"; ".png"="image/png";
  ".svg"="image/svg+xml"; ".ico"="image/x-icon"; ".txt"="text/plain; charset=utf-8";
  ".woff2"="font/woff2"; ".woff"="font/woff"; ".ttf"="font/ttf"
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "BatVault dev server: http://localhost:$Port/  (Ctrl+C to stop)"

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $req = $ctx.Request; $res = $ctx.Response
    $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart('/'))
    if ([string]::IsNullOrEmpty($rel)) { $rel = "index.html" }
    $full = Join-Path $Root $rel
    if (Test-Path $full -PathType Container) { $full = Join-Path $full "index.html" }
    if ($req.HttpMethod -eq "HEAD") { $res.StatusCode = 200; $res.OutputStream.Close(); continue }
    if (Test-Path $full -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $ct = $mime[$ext]; if (-not $ct) { $ct = "application/octet-stream" }
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $res.ContentType = $ct
      $res.Headers.Add("Cache-Control","no-cache")
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes,0,$bytes.Length)
    } else {
      $res.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $rel")
      $res.OutputStream.Write($msg,0,$msg.Length)
    }
    $res.OutputStream.Close()
  } catch { Write-Host "ERR: $_" }
}
