param([Parameter(Mandatory=$true)][string]$ImagePath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
Add-Type -AssemblyName System.Drawing
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$asTask=([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1)
function Await-Result($operation,[Type]$type) { $task=$asTask.MakeGenericMethod($type).Invoke($null,@($operation)); $task.Wait(); $task.Result }
$file=Await-Result ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream=Await-Result ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder=Await-Result ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap=Await-Result ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if(-not $engine) { throw 'Windows文字识别语言未安装' }
$result=Await-Result ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$pixels=[Drawing.Bitmap]::FromFile($ImagePath)
$items=New-Object System.Collections.Generic.List[object]
foreach($line in $result.Lines) {
    $x=[int][Math]::Floor(($line.Words.BoundingRect.X | Measure-Object -Minimum).Minimum)
    $y=[int][Math]::Floor(($line.Words.BoundingRect.Y | Measure-Object -Minimum).Minimum)
    $right=[int][Math]::Ceiling(($line.Words | ForEach-Object { $_.BoundingRect.X+$_.BoundingRect.Width } | Measure-Object -Maximum).Maximum)
    $bottom=[int][Math]::Ceiling(($line.Words | ForEach-Object { $_.BoundingRect.Y+$_.BoundingRect.Height } | Measure-Object -Maximum).Maximum)
    $width=$right-$x; $height=$bottom-$y
    $bytes=New-Object byte[] ($width*$height*3); $index=0
    for($row=$y;$row -lt $bottom;$row++){for($column=$x;$column -lt $right;$column++){$color=$pixels.GetPixel($column,$row);$bytes[$index++]=$color.R;$bytes[$index++]=$color.G;$bytes[$index++]=$color.B}}
    $sha=[Security.Cryptography.SHA256]::Create()
    $hash=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant(); $sha.Dispose()
    $items.Add([pscustomobject]@{name=($line.Text -replace '\s+','');x=$x;y=$y;width=$width;height=$height;hash=$hash})
}
$pixels.Dispose(); $bitmap.Dispose(); $stream.Dispose()
ConvertTo-Json -InputObject $items.ToArray() -Depth 3 -Compress
