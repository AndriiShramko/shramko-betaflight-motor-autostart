# Answers Chrome's native "<site> wants to connect to a serial port" picker the way a person does:
# selects the list entry whose name matches -Match and presses Connect. Windows UI Automation,
# no mouse or keyboard needed, so it works while other windows are in front.
# The picker is a pane INSIDE the browser window (not a top-level window); only a picker opened
# by -Site is touched, so other Chrome windows on the machine are left alone.
# usage: powershell -NoProfile -File pick-serial-port.ps1 [-Match 'STM32|Betaflight'] [-Site autostart.flyreelstudio.eu] [-TimeoutSec 40]
# exit 0 = picked and Connect pressed, 1 = no picker or no matching entry in time
# (ASCII only: Windows PowerShell 5.1 reads a BOM-less script as cp1252; -ConnectName covers other UI languages)
param([string]$Match = 'STM32|Betaflight', [string]$Site = 'autostart.flyreelstudio.eu', [int]$TimeoutSec = 40,
      [string]$ConnectName = '^Connect$')
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$root = $AE::RootElement
$isChrome = New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, 'Chrome_WidgetWin_1')
$isPane = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Pane)
$all = [System.Windows.Automation.Condition]::TrueCondition
$deadline = (Get-Date).AddSeconds($TimeoutSec)

function Log($m) { Write-Output ((Get-Date).ToString('HH:mm:ss') + ' picker: ' + $m) }

function Try-Pattern($el, $pattern) {
    $p = $null
    if ($el.TryGetCurrentPattern($pattern, [ref]$p)) { return $p }
    return $null
}

function Find-Picker {
    foreach ($w in $root.FindAll($Scope::Children, $isChrome)) {
        $wn = ''
        try { $wn = $w.Current.Name } catch { continue }
        if ($wn -notmatch 'Google Chrome$|Chromium$') { continue }  # browser windows only, not Electron apps
        foreach ($p in $w.FindAll($Scope::Descendants, $isPane)) {
            $n = ''
            try { $n = $p.Current.Name } catch { continue }
            if ($n.StartsWith($Site) -and $n -match 'serial port') { return $p }
        }
    }
    return $null
}

$seen = $false
while ((Get-Date) -lt $deadline) {
    $picker = Find-Picker
    if (-not $picker) { Start-Sleep -Milliseconds 400; continue }
    if (-not $seen) { Log ('picker open: ' + $picker.Current.Name); $seen = $true }
    $entry = $null
    $connect = $null
    $names = @()
    foreach ($el in $picker.FindAll($Scope::Descendants, $all)) {
        $n = ''
        try { $n = $el.Current.Name } catch { continue }
        $type = $el.Current.ControlType
        if ($type -eq $CT::DataItem -or $type -eq $CT::ListItem) {
            $names += $n
            if (-not $entry -and $n -match $Match) { $entry = $el }
        }
        if ($type -eq $CT::Button -and $n -match $ConnectName) { $connect = $el }
    }
    if (-not $entry) { Start-Sleep -Milliseconds 500; continue }  # the list fills in a moment later
    Log ('ports listed: ' + (($names | Where-Object { $_ }) -join ' | '))
    Log ('picking "' + $entry.Current.Name + '"')
    # Chrome's table: an unnamed row (Invoke = click it) holding a named cell. Selecting the cell
    # through SelectionItem picks a different row, so click the row, then check what is selected.
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $row = $walker.GetParent($entry)
    $cells = @($picker.FindAll($Scope::Descendants, $all) | Where-Object { $_.Current.ControlType -eq $CT::DataItem -and $_.Current.Name })
    $selected = {
        (@($cells | Where-Object {
            $sp = Try-Pattern $_ ([System.Windows.Automation.SelectionItemPattern]::Pattern)
            $sp -and $sp.Current.IsSelected
        } | ForEach-Object { $_.Current.Name })) -join ' | '
    }
    $want = $entry.Current.Name  # exactly this entry selected, nothing else
    $inv = Try-Pattern $row ([System.Windows.Automation.InvokePattern]::Pattern)
    if ($inv) { $inv.Invoke() }
    Start-Sleep -Milliseconds 300
    $now = & $selected
    if ($now -ne $want) {
        $sel = Try-Pattern $entry ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($sel) { $sel.Select(); Start-Sleep -Milliseconds 300; $now = & $selected }
    }
    Log ('selected in the picker: "' + $now + '"')
    if ($now -ne $want) { Log 'the board is not the selected entry: Connect NOT pressed'; exit 1 }
    for ($i = 0; $i -lt 10 -and $connect -and -not $connect.Current.IsEnabled; $i++) { Start-Sleep -Milliseconds 200 }
    if (-not $connect) { Log 'no Connect button found'; exit 1 }
    if (-not $connect.Current.IsEnabled) { Log 'Connect still disabled after selecting'; exit 1 }
    $ci = Try-Pattern $connect ([System.Windows.Automation.InvokePattern]::Pattern)
    if (-not $ci) { Log 'Connect has no Invoke pattern'; exit 1 }
    $ci.Invoke()
    Log 'Connect pressed'
    exit 0
}
if ($seen) { Log ('no port matching ' + $Match + ' in the picker') } else { Log ('no picker within ' + $TimeoutSec + ' s') }
exit 1
