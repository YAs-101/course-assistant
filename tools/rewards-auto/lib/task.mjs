/**
 * Building the Windows scheduled task definition.
 *
 * `schtasks /Create` is the only mechanism that works for a non-admin account on
 * this machine: `Register-ScheduledTask` returns "Access is denied", and
 * `/Create /SC ONLOGON` without `/RU` fails the same way. What does work is
 * `/Create /XML`, provided every principal and trigger `UserId` is the **full
 * SID** -- a short account name such as `SA` fails with "No mapping between
 * account names and security IDs was done".
 *
 * That detail is the reason this file is a pure function plus a small CLI: the
 * XML is easy to get subtly wrong, and `test/task.test.js` can pin the fields
 * that matter without creating a task.
 *
 * The XML must be written as UTF-16LE with a BOM; schtasks reads it as UTF-16
 * and a UTF-8 file comes back as a parse error.
 */
import { writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Task name used by every script in this directory. */
export const TASK_NAME = 'MSRewards-AutoDaily'

/** Escape the five XML-significant characters. */
export function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Render the task definition XML.
 *
 * Design notes, each tied to a failure mode:
 *
 *   - `LogonTrigger` with `Delay` PT2M: give the desktop a moment to settle, but
 *     not so long that a quick login is missed entirely.
 *   - `Repetition` PT30M over PT2H: if Edge had a visible window at login, retry
 *     a few times rather than skipping the day.
 *   - `MultipleInstancesPolicy=IgnoreNew`: an overlapping run must not start a
 *     second browser against the same profile.
 *   - `ExecutionTimeLimit` PT15M: a hung run must not hold the task for ever.
 *   - `RunOnlyIfNetworkAvailable`: searching without a network is pointless.
 *   - `DisallowStartIfOnBatteries=false`: a laptop running on battery should
 *     still earn the points.
 *   - `RunLevel=LeastPrivilege` + `LogonType=InteractiveToken`: no elevation, and
 *     a UI session exists for the browser to open into.
 *
 * @param options.sid - full account SID, e.g. `S-1-5-21-...-1001`.
 * @returns the XML document as a string (with a leading BOM-free body).
 */
export function buildTaskXml({
  sid,
  taskName = TASK_NAME,
  wscriptPath = 'C:\\Windows\\System32\\wscript.exe',
  vbsPath,
  delayMinutes = 2,
  repeatMinutes = 30,
  durationHours = 2,
  timeLimitMinutes = 15,
  description = 'Earn daily Microsoft Rewards search points in Edge, then close it.',
} = {}) {
  if (!sid) throw new Error('buildTaskXml: sid is required')
  // A short name here is the exact mistake that took several attempts to
  // diagnose; reject it loudly instead of producing a task schtasks will refuse.
  if (!/^S-\d-\d+(-\d+)*$/.test(String(sid))) {
    throw new Error(`buildTaskXml: "${sid}" is not a SID (use the full S-1-5-... form)`)
  }
  if (!vbsPath) throw new Error('buildTaskXml: vbsPath is required')

  const startBoundary = '2026-01-01T00:00:00'
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>ms-rewards-auto</Author>
    <Description>${xmlEscape(description)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(sid)}</UserId>
      <Delay>PT${Math.max(0, Math.floor(delayMinutes))}M</Delay>
      <Repetition>
        <Interval>PT${Math.max(1, Math.floor(repeatMinutes))}M</Interval>
        <Duration>PT${Math.max(1, Math.floor(durationHours))}H</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(sid)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT${Math.max(1, Math.floor(timeLimitMinutes))}M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(wscriptPath)}</Command>
      <Arguments>"${xmlEscape(vbsPath)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`
}

/**
 * Write the task XML the way schtasks wants it: UTF-16LE with a BOM.
 *
 * `writeFileSync` with `'utf16le'` does not emit a BOM, so it is prepended by
 * hand; without it schtasks reports the document is not valid XML.
 */
export function writeTaskXml(file, xml) {
  const body = String(xml ?? '').replace(/^\uFEFF/, '')
  writeFileSync(file, '\uFEFF' + body, 'utf16le')
  return file
}

/** CLI: `node lib/task.mjs --write <file> --sid <SID> --vbs <path> [--repeat 30]`. */
function main(argv) {
  const args = argv.slice(2)
  const get = (flag, fallback = null) => {
    const index = args.indexOf(flag)
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback
  }
  const writeTo = get('--write')
  if (!writeTo) {
    console.error('usage: node lib/task.mjs --write <file> --sid <SID> --vbs <launch.vbs>')
    return 2
  }
  const xml = buildTaskXml({
    sid: get('--sid'),
    taskName: get('--name', TASK_NAME),
    vbsPath: get('--vbs'),
    wscriptPath: get('--wscript', 'C:\\Windows\\System32\\wscript.exe'),
    delayMinutes: Number(get('--delay', '2')),
    repeatMinutes: Number(get('--repeat', '30')),
    durationHours: Number(get('--duration', '2')),
    timeLimitMinutes: Number(get('--limit', '15')),
  })
  writeTaskXml(writeTo, xml)
  console.log(writeTo)
  return 0
}

// Only run when invoked directly, not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv)
}
