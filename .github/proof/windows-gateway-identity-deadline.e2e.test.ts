import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeWorkerSupervisorFixture } from "../../src/node-host/node-worker-supervisor.fixture.test-support.js";
import {
  TEST_WORKER_ENDPOINT,
  testWorkerLaunchInput,
} from "../../src/node-host/node-worker-supervisor.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../../src/state/openclaw-state-db.js";

const SINGLE_DEADLINE_HEAD = "a4c8c09ba615df6ad4483696a00cd88a47c37391";
const artifactDir = process.env.OPENCLAW_WINDOWS_CRON_PROOF_DIR;

if (!artifactDir) {
  throw new Error("OPENCLAW_WINDOWS_CRON_PROOF_DIR is required");
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${path.basename(filePath)}`);
}

async function collectProcess(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("product command timed out"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

const monitorSource = String.raw`
param(
  [Parameter(Mandatory = $true)][string] $ReadyPath,
  [Parameter(Mandatory = $true)][int] $TargetPid,
  [Parameter(Mandatory = $true)][string] $DonePath,
  [Parameter(Mandatory = $true)][string] $EvidencePath
)
$ErrorActionPreference = "Stop"
$native = @"
using System;
using System.Runtime.InteropServices;
public static class OpenClawProofProcessControl {
  [StructLayout(LayoutKind.Sequential)]
  private struct ProcessBasicInformation {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr InheritedFromUniqueProcessId;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")]
  private static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")]
  private static extern int NtResumeProcess(IntPtr handle);
  [DllImport("ntdll.dll")]
  private static extern int NtQueryInformationProcess(IntPtr handle, int informationClass, ref ProcessBasicInformation information, int informationLength, out int returnLength);
  public static int ParentId(int processId) {
    IntPtr handle = OpenProcess(0x1000, false, processId);
    if (handle == IntPtr.Zero) return -1;
    try {
      ProcessBasicInformation information = new ProcessBasicInformation();
      int returnLength;
      int status = NtQueryInformationProcess(handle, 0, ref information, Marshal.SizeOf(information), out returnLength);
      return status == 0 ? information.InheritedFromUniqueProcessId.ToInt32() : -1;
    } finally { CloseHandle(handle); }
  }
  public static int Suspend(int processId) {
    IntPtr handle = OpenProcess(0x0800, false, processId);
    if (handle == IntPtr.Zero) return -1;
    try { return NtSuspendProcess(handle); } finally { CloseHandle(handle); }
  }
  public static int Resume(int processId) {
    IntPtr handle = OpenProcess(0x0800, false, processId);
    if (handle == IntPtr.Zero) return -1;
    try { return NtResumeProcess(handle); } finally { CloseHandle(handle); }
  }
}
"@
Add-Type -TypeDefinition $native
$source = "openclaw-proof-$PID"
$events = @()
$suspendedPid = $null
$suspendStatus = $null
$resumeStatus = $null
$wmicSeen = $false
try {
  $knownPowerShell = @(Get-Process powershell -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  Register-CimIndicationEvent -Namespace root/cimv2 -Query "SELECT * FROM Win32_ProcessStartTrace" -SourceIdentifier $source | Out-Null
  Set-Content -LiteralPath $ReadyPath -Value "ready"
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  $doneDeadline = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $DonePath) {
      if ($null -eq $doneDeadline) {
        $doneDeadline = [DateTime]::UtcNow.AddSeconds(1)
      } elseif ([DateTime]::UtcNow -ge $doneDeadline) {
        break
      }
    }
    if ($null -eq $suspendedPid) {
      $candidate = Get-Process powershell -ErrorAction SilentlyContinue |
        Where-Object {
          $_.Id -notin $knownPowerShell -and
          [OpenClawProofProcessControl]::ParentId($_.Id) -eq $TargetPid
        } |
        Sort-Object StartTime |
        Select-Object -First 1
      if ($null -ne $candidate) {
        $suspendedPid = $candidate.Id
        $suspendStatus = [OpenClawProofProcessControl]::Suspend($suspendedPid)
        $events += [pscustomobject][ordered]@{
          name = "powershell.exe"
          pid = $suspendedPid
          parentPid = $TargetPid
          observedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
        continue
      }
      Start-Sleep -Milliseconds 1
      continue
    }
    $event = Wait-Event -SourceIdentifier $source -Timeout 1 -ErrorAction SilentlyContinue
    if ($null -eq $event) {
      continue
    }
    $started = $event.SourceEventArgs.NewEvent
    $record = [ordered]@{
      name = [string]$started.ProcessName
      pid = [int]$started.ProcessID
      parentPid = [int]$started.ParentProcessID
      observedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    }
    if ($record.parentPid -ne $TargetPid) {
      Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue
      continue
    }
    $events += [pscustomobject]$record
    if ($record.name -ieq "wmic.exe") {
      $wmicSeen = $true
    }
    Remove-Event -EventIdentifier $event.EventIdentifier -ErrorAction SilentlyContinue
  }
} finally {
  if ($null -ne $suspendedPid -and (Get-Process -Id $suspendedPid -ErrorAction SilentlyContinue)) {
    $resumeStatus = [OpenClawProofProcessControl]::Resume($suspendedPid)
  }
  Unregister-Event -SourceIdentifier $source -ErrorAction SilentlyContinue
  Get-Event -SourceIdentifier $source -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
  [ordered]@{
    targetPid = $TargetPid
    suspendedPid = $suspendedPid
    suspendStatus = $suspendStatus
    resumeStatus = $resumeStatus
    wmicSeen = $wmicSeen
    events = $events
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $EvidencePath
}
`;

describe("Windows worker identity deadline proof", () => {
  it(
    "keeps a worker launch available after a late PowerShell probe",
    { timeout: 60_000 },
    async () => {
      await fs.mkdir(artifactDir, { recursive: true });
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-deadline-"));
      const { supervisor, workspaceDir } = createNodeWorkerSupervisorFixture(root, {
        capacity: 1,
      });
      const monitorPath = path.join(artifactDir, "deadline-monitor.ps1");
      const readyPath = path.join(artifactDir, "deadline-monitor.ready");
      const donePath = path.join(artifactDir, "deadline-worker.done");
      const monitorEvidencePath = path.join(artifactDir, "deadline-monitor.json");
      await fs.writeFile(monitorPath, monitorSource);

      try {
        const monitor = spawn(
          "pwsh.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-File",
            monitorPath,
            "-ReadyPath",
            readyPath,
            "-TargetPid",
            String(process.pid),
            "-DonePath",
            donePath,
            "-EvidencePath",
            monitorEvidencePath,
          ],
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        await waitForFile(readyPath, 15_000);

        const startedAt = Date.now();
        let launch: Record<string, unknown> | undefined;
        let launchError: string | undefined;
        try {
          launch = await supervisor.launch(
            testWorkerLaunchInput(workspaceDir, "deadline-proof", "success"),
            TEST_WORKER_ENDPOINT,
          );
        } catch (error) {
          launchError = error instanceof Error ? error.message : String(error);
        }
        const elapsedMs = Date.now() - startedAt;
        await fs.writeFile(donePath, "done\n");
        const monitorResult = await collectProcess(monitor, 15_000);
        await waitForFile(monitorEvidencePath, 1_000);
        const monitorEvidence = JSON.parse(
          await fs.readFile(monitorEvidencePath, "utf8"),
        ) as Record<string, unknown>;
        const targetSha = spawnSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
        }).stdout.trim();
        const expectsSingleDeadline = targetSha === SINGLE_DEADLINE_HEAD;
        const evidence = {
          targetSha,
          expectsSingleDeadline,
          worker: { launch, launchError, elapsedMs },
          monitor: { ...monitorResult, evidence: monitorEvidence },
        };
        await fs.writeFile(
          path.join(artifactDir, "worker-deadline-proof.json"),
          `${JSON.stringify(evidence, null, 2)}\n`,
        );

        expect(monitorResult.code, monitorResult.stderr).toBe(0);
        expect(monitorEvidence.suspendStatus).toBe(0);
        expect(monitorEvidence.wmicSeen).toBe(!expectsSingleDeadline);
        expect(elapsedMs).toBeLessThan(expectsSingleDeadline ? 6_500 : 12_000);
        expect(launchError).toBeUndefined();
        expect(launch).toMatchObject({ state: "running" });
      } finally {
        await supervisor.close();
        closeOpenClawStateDatabaseForTest();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
