#requires -Version 5
# Windows audio-endpoint helper for the soundboard.
#
# One job, and deliberately nothing else: the *default device* roles that
# VB-CABLE's installer hijacks. Windows keeps three of them per direction —
# console, multimedia, and communications — and exposes no public API to set
# them. When the installer points any of those at the cable, every app's audio
# (or every app's recording) follows the cable into Discord. Fixing that by
# hand means a trip through the Sound control panel; this does it in one call.
#
# Default selection goes through IPolicyConfig, the same undocumented COM
# interface the Sound control panel itself uses. It runs in the user's own
# context and needs NO elevation. This script installs no drivers, writes no
# registry keys, and changes no device formats — it only reassigns default
# roles, which the user can undo from the Sound panel like any manual change.
#
# Enumeration goes through the documented Core Audio COM interfaces, reading
# PKEY_Device_FriendlyName from each endpoint's property store. That is the
# same string Chromium reports from enumerateDevices(), so the names the app
# passes in line up with the names found here.
#
# Actions:
#   list        enumerate active render/capture endpoints as JSON, flagging
#               which are currently the default for each role
#   setdefault  make one matched endpoint the default for all three roles
#   selftest    re-assert the current console defaults to themselves (a no-op
#               that proves the COM path returns success without changing them)
#
# Device match strings arrive base64-encoded (-MatchB64) so that a device name,
# however punctuated, can never be parsed as a PowerShell argument.

[CmdletBinding()]
param(
  [ValidateSet('list', 'setdefault', 'selftest', 'getrate', 'setrate')]
  [string]$Action = 'list',
  [ValidateSet('render', 'capture')]
  [string]$Flow = 'render',
  [string]$MatchB64 = '',
  [int]$Rate = 48000
)

$ErrorActionPreference = 'Stop'

Add-Type -Language CSharp @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace Soundboard {
  // IPolicyConfig: undocumented, but stable since Vista. Only SetDefaultEndpoint
  // is called; every method before it is declared purely to place it at the
  // correct vtable slot, so the earlier signatures are left as opaque IntPtr.
  [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    int GetMixFormat(string d, IntPtr f);
    int GetDeviceFormat(string d, int def, IntPtr f);
    int ResetDeviceFormat(string d);
    int SetDeviceFormat(string d, IntPtr e, IntPtr m);
    int GetProcessingPeriod(string d, int def, IntPtr p, IntPtr min);
    int SetProcessingPeriod(string d, IntPtr p);
    int GetShareMode(string d, IntPtr m);
    int SetShareMode(string d, IntPtr m);
    int GetPropertyValue(string d, int store, IntPtr key, IntPtr v);
    int SetPropertyValue(string d, int store, IntPtr key, IntPtr v);
    int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
    int SetEndpointVisibility(string d, int visible);
  }

  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
  class CPolicyConfigClient { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int flow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice ep);
  }

  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    int GetCount(out int count);
    int Item(int index, out IMMDevice device);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int ctx, IntPtr p, out IntPtr iface);
    int OpenPropertyStore(int access, out IPropertyStore store);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    int GetCount(out int count);
    int GetAt(int index, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    int Commit();
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROPERTYKEY { public Guid fmtid; public int pid; }

  // Only the string variants of PROPVARIANT are needed. The union begins at
  // offset 8 on both x86 and x64 (2-byte vt + three 2-byte reserved fields).
  [StructLayout(LayoutKind.Explicit)]
  struct PROPVARIANT {
    [FieldOffset(0)] public short vt;
    [FieldOffset(8)] public IntPtr p;
    public string AsString() {
      if (vt == 31) return Marshal.PtrToStringUni(p);   // VT_LPWSTR
      if (vt == 8)  return Marshal.PtrToStringBSTR(p);   // VT_BSTR
      return null;
    }
  }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorComObject { }

  public static class Policy {
    const int DEVICE_STATE_ACTIVE = 0x1;
    const int STGM_READ = 0x0;
    static PROPERTYKEY PKEY_FriendlyName = new PROPERTYKEY {
      fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14
    };

    // Active endpoints for one flow (0 render, 1 capture), each as
    // "id\tfriendlyName". Matches the set and names Chromium enumerates.
    public static string[] Enumerate(int flow) {
      var list = new List<string>();
      IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IMMDeviceCollection col;
      if (en.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, out col) != 0 || col == null) return list.ToArray();
      int n; col.GetCount(out n);
      for (int i = 0; i < n; i++) {
        IMMDevice d;
        if (col.Item(i, out d) != 0 || d == null) continue;
        string id;
        if (d.GetId(out id) != 0) continue;
        string name = null;
        IPropertyStore ps;
        if (d.OpenPropertyStore(STGM_READ, out ps) == 0 && ps != null) {
          PROPVARIANT pv;
          if (ps.GetValue(ref PKEY_FriendlyName, out pv) == 0) name = pv.AsString();
        }
        list.Add(id + "\t" + (name ?? ""));
      }
      return list.ToArray();
    }

    // Set an endpoint's shared-mode format (the Advanced-tab "Default Format").
    // Takes a WAVEFORMATEX(TENSIBLE) byte blob, passed as both the endpoint and
    // the mix format. This is what the Sound panel calls, and like the panel it
    // runs without elevation. Returns the HRESULT.
    public static int SetDeviceFormat(string id, byte[] fmt) {
      IntPtr p = Marshal.AllocHGlobal(fmt.Length);
      try {
        Marshal.Copy(fmt, 0, p, fmt.Length);
        IPolicyConfig cfg = (IPolicyConfig)(new CPolicyConfigClient());
        return cfg.SetDeviceFormat(id, p, p);
      } finally {
        Marshal.FreeHGlobal(p);
      }
    }

    // Set one endpoint as the default for all three roles. Returns the first
    // non-zero HRESULT, or 0 when every role took.
    public static int SetDefault(string id) {
      IPolicyConfig cfg = (IPolicyConfig)(new CPolicyConfigClient());
      int hr = 0, r;
      r = cfg.SetDefaultEndpoint(id, 0); if (r != 0 && hr == 0) hr = r; // eConsole
      r = cfg.SetDefaultEndpoint(id, 1); if (r != 0 && hr == 0) hr = r; // eMultimedia
      r = cfg.SetDefaultEndpoint(id, 2); if (r != 0 && hr == 0) hr = r; // eCommunications
      return hr;
    }

    // Current default endpoint id for one role, or "" when none is set.
    public static string GetDefaultId(int flow, int role) {
      try {
        IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        IMMDevice dev;
        if (en.GetDefaultAudioEndpoint(flow, role, out dev) != 0 || dev == null) return "";
        string id;
        if (dev.GetId(out id) != 0) return "";
        return id;
      } catch { return ""; }
    }
  }
}
'@

function Get-Endpoints {
  param([string]$flow)
  $flowNum = if ($flow -eq 'capture') { 1 } else { 0 }
  $defMulti = [Soundboard.Policy]::GetDefaultId($flowNum, 1)
  $defComm = [Soundboard.Policy]::GetDefaultId($flowNum, 2)

  $out = @()
  foreach ($line in [Soundboard.Policy]::Enumerate($flowNum)) {
    $parts = $line -split "`t", 2
    $id = $parts[0]
    $out += [pscustomobject]@{
      id           = $id
      name         = if ($parts.Count -gt 1) { $parts[1] } else { '' }
      defaultMulti = ($id -eq $defMulti)
      defaultComm  = ($id -eq $defComm)
    }
  }
  return $out
}

# The default shared-mode format lives in the registry as a WAVEFORMATEX blob.
# Read-only; used both to report the current rate and as the base to patch.
$FORMAT_KEY = '{f19f064d-082c-4e27-bc73-6882a1bb8e4c},0' # PKEY_AudioEngine_DeviceFormat

function Get-FormatBlob {
  param([string]$flow, [string]$id)
  $leaf = if ($flow -eq 'capture') { 'Capture' } else { 'Render' }
  # The registry subkey is the device guid, i.e. the id after "}.".
  $guid = $id.Substring($id.IndexOf('}.') + 2)
  $props = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\$leaf\$guid\Properties"
  try { return [byte[]](Get-ItemProperty -LiteralPath $props -Name $FORMAT_KEY -ErrorAction Stop).$FORMAT_KEY } catch { return $null }
}

# The registry blob is a WAVEFORMATEX behind an 8-byte header on current Windows,
# but rather than assume that, locate the structure: the first offset whose
# wFormatTag is PCM/float/extensible and whose sample rate is plausible. Returns
# the bare WAVEFORMATEX bytes — which is what IPolicyConfig::SetDeviceFormat
# expects — or $null.
function Get-WaveFormat {
  param([string]$flow, [string]$id)
  $blob = Get-FormatBlob $flow $id
  if (-not $blob) { return $null }
  foreach ($o in 8, 0) {
    if ($blob.Length -lt $o + 16) { continue }
    $tag = [BitConverter]::ToUInt16($blob, $o)
    $rate = [BitConverter]::ToUInt32($blob, $o + 4)
    if (($tag -eq 0x0001 -or $tag -eq 0x0003 -or $tag -eq 0xFFFE) -and $rate -ge 8000 -and $rate -le 768000) {
      return , ([byte[]]$blob[$o..($blob.Length - 1)])
    }
  }
  return $null
}

# WAVEFORMATEX layout: nChannels@2, nSamplesPerSec@4, nAvgBytesPerSec@8,
# nBlockAlign@12, wBitsPerSample@14 (all little-endian).
function Read-Rate {
  param([byte[]]$wf)
  if (-not $wf -or $wf.Length -lt 16) { return $null }
  [pscustomobject]@{
    channels = [BitConverter]::ToUInt16($wf, 2)
    rate     = [BitConverter]::ToUInt32($wf, 4)
    bits     = [BitConverter]::ToUInt16($wf, 14)
  }
}

# Return a copy of the blob with the sample rate changed, recomputing the only
# other rate-dependent field (nAvgBytesPerSec = rate * nBlockAlign). Channels
# and bit depth are left exactly as the user configured them.
function Set-RateInWave {
  param([byte[]]$wf, [int]$rate)
  $out = [byte[]]$wf.Clone()
  $blockAlign = [BitConverter]::ToUInt16($out, 12)
  [BitConverter]::GetBytes([uint32]$rate).CopyTo($out, 4)
  [BitConverter]::GetBytes([uint32]($rate * $blockAlign)).CopyTo($out, 8)
  return , $out
}

function Resolve-Match {
  param($endpoints, [string]$match)
  $named = @($endpoints | Where-Object { $_.name })
  $m = $match.Trim().ToLowerInvariant()
  if (-not $m) { return $null }
  # Exact name, then prefix, then either-way substring. Chromium's device label
  # and the endpoint friendly name are normally identical; the looser passes
  # just absorb trivial drift.
  foreach ($e in $named) { if ($e.name.Trim().ToLowerInvariant() -eq $m) { return $e } }
  foreach ($e in $named) { if ($e.name.Trim().ToLowerInvariant().StartsWith($m)) { return $e } }
  foreach ($e in $named) {
    $n = $e.name.Trim().ToLowerInvariant()
    if ($n.Contains($m) -or $m.Contains($n)) { return $e }
  }
  return $null
}

switch ($Action) {
  'list' {
    [pscustomobject]@{
      render  = @(Get-Endpoints 'render')
      capture = @(Get-Endpoints 'capture')
    } | ConvertTo-Json -Depth 5 -Compress
  }

  'setdefault' {
    $match = if ($MatchB64) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($MatchB64)) } else { '' }
    $pick = Resolve-Match (Get-Endpoints $Flow) $match
    if (-not $pick) {
      [pscustomobject]@{ ok = $false; error = "no active $Flow device matched" } | ConvertTo-Json -Compress
      break
    }
    $hr = [Soundboard.Policy]::SetDefault($pick.id)
    [pscustomobject]@{ ok = ($hr -eq 0); hr = $hr; id = $pick.id; name = $pick.name } | ConvertTo-Json -Compress
  }

  'getrate' {
    $match = if ($MatchB64) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($MatchB64)) } else { '' }
    $pick = Resolve-Match (Get-Endpoints $Flow) $match
    if (-not $pick) {
      [pscustomobject]@{ ok = $false; error = "no active $Flow device matched" } | ConvertTo-Json -Compress
      break
    }
    $fmt = Read-Rate (Get-WaveFormat $Flow $pick.id)
    if (-not $fmt) {
      [pscustomobject]@{ ok = $false; error = "could not read current format"; name = $pick.name } | ConvertTo-Json -Compress
      break
    }
    [pscustomobject]@{ ok = $true; name = $pick.name; rate = $fmt.rate; channels = $fmt.channels; bits = $fmt.bits } | ConvertTo-Json -Compress
  }

  'setrate' {
    $match = if ($MatchB64) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($MatchB64)) } else { '' }
    $pick = Resolve-Match (Get-Endpoints $Flow) $match
    if (-not $pick) {
      [pscustomobject]@{ ok = $false; error = "no active $Flow device matched" } | ConvertTo-Json -Compress
      break
    }
    $wf = Get-WaveFormat $Flow $pick.id
    if (-not $wf) {
      [pscustomobject]@{ ok = $false; error = "could not read current format"; name = $pick.name } | ConvertTo-Json -Compress
      break
    }
    $before = (Read-Rate $wf).rate
    $patched = Set-RateInWave $wf $Rate
    $hr = [Soundboard.Policy]::SetDeviceFormat($pick.id, $patched)
    # Read back so success reflects what Windows actually stored, not just the
    # HRESULT.
    $after = (Read-Rate (Get-WaveFormat $Flow $pick.id)).rate
    [pscustomobject]@{ ok = ($hr -eq 0 -and $after -eq $Rate); hr = $hr; name = $pick.name; before = $before; after = $after; target = $Rate } | ConvertTo-Json -Compress
  }

  'selftest' {
    # Prove SetDefaultEndpoint reaches the right vtable slot without changing
    # anything the user would notice: read the current console defaults and set
    # them to themselves. A wrong slot would return a non-zero HRESULT here.
    $results = @()
    foreach ($f in 0, 1) {
      $id = [Soundboard.Policy]::GetDefaultId($f, 0)
      if ($id) { $results += [Soundboard.Policy]::SetDefault($id) }
    }
    $bad = @($results | Where-Object { $_ -ne 0 })
    [pscustomobject]@{ ok = ($bad.Count -eq 0); results = $results } | ConvertTo-Json -Compress
  }
}
