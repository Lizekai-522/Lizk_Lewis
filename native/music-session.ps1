param([ValidateSet('read','pause','play','next')][string]$Action='read')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$asTask=([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1)
function Await-Result($operation,[Type]$type) { $task=$asTask.MakeGenericMethod($type).Invoke($null,@($operation)); $task.Wait(); $task.Result }
$manager=Await-Result ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$sessions=@($manager.GetSessions() | Where-Object { $_.SourceAppUserModelId -match '(?i)(^|[\\/.])qqmusic(\.exe)?$' })
if($sessions.Count -ne 1){ConvertTo-Json -InputObject @{available=$false;playing=$false;status='Unavailable'} -Compress;exit}
$session=$sessions[0]
if($Action -ne 'read') {
    $operation=switch($Action){'pause'{$session.TryPauseAsync()};'play'{$session.TryPlayAsync()};'next'{$session.TrySkipNextAsync()}}
    $accepted=Await-Result $operation ([bool])
    Start-Sleep -Milliseconds 250
} else { $accepted=$null }
$info=$session.GetPlaybackInfo()
$media=Await-Result ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
$timeline=$session.GetTimelineProperties()
ConvertTo-Json -InputObject @{available=$true;accepted=$accepted;playing=($info.PlaybackStatus.ToString() -eq 'Playing');status=$info.PlaybackStatus.ToString();title=$media.Title;artist=$media.Artist;position=$timeline.Position.TotalSeconds} -Depth 3 -Compress
