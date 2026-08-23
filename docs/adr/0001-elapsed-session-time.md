# Elapsed session time, not plug-in elapsed

This plugin’s panel should show how long the current charging session or discharging session has been running. That clock lives on OverStyleFR/omarchy-battery-usage PR 3, not in the omarchy repo. Plug-in elapsed (Omarchy PR 7681) keeps ticking after the battery is full and never starts on unplug, so it answers neither “how long is this charge taking” nor “how long is this discharge taking.” Remaining time (time to full / time left) stays as its own row.

A switch to the opposite direction shorter than five minutes is a session interruption: the line follows current flow immediately, then the original session resumes and the blip is discarded. Fully charged, holding, or pending-charge ends a charging session. The clock persists across shell restart and sleep. Existing Omarchy `battery-plugged-at` files are ignored.

The compact battery-activity summary also models an **unplugged interval**, but that is deliberately separate from elapsed session time. An unplugged interval starts and ends at observed `ac_online` transitions, while charging and discharging sessions remain based on normalized energy flow and retain the five-minute interruption rule above. Connected idle/full time therefore never extends a charging session, and an unplugged interval does not become a discharging-session synonym.

**Considered options:** plug-in elapsed in Omarchy’s power panel (PR 7681); remaining time only (already on this panel); treating this plugin’s five-minute sample gap as the session-interruption rule. Rejected because the live clock belongs with this plugin’s session history, remaining time answers a different question, and a sample gap (no samples) is not a direction switch.
