$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$entries = New-Object System.Collections.Generic.List[object]
$shell = New-Object -ComObject WScript.Shell
# Search only installation registrations and Start Menu shortcuts, never the entire disk.
foreach ($folder in @((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'), (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'), [Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('CommonDesktopDirectory'))) {
    Get-ChildItem -LiteralPath $folder -Filter *.lnk -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $shortcut = $shell.CreateShortcut($_.FullName)
            $target = [Environment]::ExpandEnvironmentVariables($shortcut.TargetPath)
            if ($target -match '(?i)\.exe$' -and (Test-Path -LiteralPath $target -PathType Leaf) -and $_.BaseName -notmatch '卸载|uninstall|帮助|help') {
                $entries.Add([pscustomobject]@{name=$_.BaseName; executable=$target; shortcut=$_.FullName})
            }
        } catch { }
    }
}
foreach ($registryRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')) {
    Get-ChildItem -LiteralPath $registryRoot -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            $target = [Environment]::ExpandEnvironmentVariables([string]$_.GetValue('')).Trim('"')
            if ($target -match '(?i)\.exe$' -and (Test-Path -LiteralPath $target -PathType Leaf)) {
                $name = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($target).ProductName
                if (-not $name) { $name = [IO.Path]::GetFileNameWithoutExtension($target) }
                $entries.Add([pscustomobject]@{name=$name; executable=$target; shortcut=$null})
            }
        } catch { }
    }
}
# Store apps are launched through their registered application ID.
foreach ($registryRoot in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    Get-ItemProperty -Path ($registryRoot+'\*') -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.DisplayName -and [string]$_.DisplayIcon -match '^"?([^"\r\n]+?\.exe)') {
            $target = [Environment]::ExpandEnvironmentVariables($matches[1])
            if (Test-Path -LiteralPath $target -PathType Leaf) { $entries.Add([pscustomobject]@{name=$_.DisplayName; executable=$target; shortcut=$null}) }
        }
    }
}
try {
    Get-StartApps | ForEach-Object {
        if ($_.AppID -match '^[A-Za-z0-9._-]+![A-Za-z0-9._-]+$') {
            $entries.Add([pscustomobject]@{name=$_.Name; appId=$_.AppID})
        }
    }
} catch { }
ConvertTo-Json -InputObject $entries.ToArray() -Compress -Depth 3
