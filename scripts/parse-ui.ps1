# Parse uiautomator dump to extract clickable elements with bounds
[xml]$x = Get-Content $args[0] -Raw
function Walk($n, $depth = 0) {
  if ($null -ne $n) {
    $label = ''
    if ($n.'content-desc') { $label = $n.'content-desc' }
    elseif ($n.text) { $label = $n.text }
    if ($label -and $n.bounds) {
      $b = $n.bounds -replace '[\[\]]', '' -split ','
      if ($b.Length -eq 4) {
        $cx = ([int]$b[0] + [int]$b[2]) / 2
        $cy = ([int]$b[1] + [int]$b[3]) / 2
        $clickable = $n.clickable
        Write-Host ("{0,-30} cx={1} cy={2} click={3}" -f $label.Substring(0, [Math]::Min(30, $label.Length)), $cx, $cy, $clickable)
      }
    }
    if ($n.node) { Walk $n.node ($depth + 1) }
  }
}
Walk $x.hierarchy
