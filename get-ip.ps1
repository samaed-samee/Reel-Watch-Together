# Prints the first non-loopback, non-APIPA IPv4 address of this PC.
$ip = Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127*' -and $_.IPAddress -notlike '169.254*' } |
  Select-Object -First 1
if ($ip) { $ip.IPAddress }
